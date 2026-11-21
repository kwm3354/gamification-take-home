import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { ALPHA_MANAGER, ALPHA_VIEWER, BETA_MANAGER, OPS, adminHeaders } from "./admin-login.ts";
import { startApp } from "./app.ts";
import { alphaDeposit, betaTxn, signAlpha, signBeta, tokenFor } from "./signing.ts";

// Replacing a tenant's secrets, checked through HTTP: what the casino sends must be accepted or
// rejected as the key rules say. The current secrets are tracked here, as the casino would hold them.
const running = await startApp();
const app = () => {
  if (!running) throw new Error("no app");
  return running;
};

const ALPHA = "alpha-casino";
const BETA = "beta-casino";
type Kind = "event_signing" | "player_token";
const tenantNamed = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};

// What the casino holds now, and every secret that ever existed (for the "no secret anywhere" scan).
const held: Record<string, Record<Kind, string>> = {};
const everSeen = new Set<string>();
for (const t of demoTenants) {
  held[t.id] = { event_signing: t.webhookSecret, player_token: t.tokenSecret };
  everSeen.add(t.webhookSecret);
  everSeen.add(t.tokenSecret);
}

beforeAll(async () => {
  if (running) await seedDemo(running.db, running.clock, "http://127.0.0.1:1");
});
afterAll(() => running?.close());

const now = () => app().clock.now().getTime();
const adminOf = (tenant: string) => (tenant === ALPHA ? ALPHA_MANAGER : BETA_MANAGER);

async function admin(email: string, method: "GET" | "POST", path: string, body?: unknown) {
  const r = await fetch(`${app().url}${path}`, {
    method,
    headers: await adminHeaders(app(), email, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, text };
}

/** Rotates as the tenant's own manager and remembers the new secret as the one the casino holds. */
async function rotate(tenant: string, kind: Kind, previousValidForSec: number, email = adminOf(tenant)) {
  const r = await admin(email, "POST", `/admin/${tenant}/keys/${kind}/rotate`, { previousValidForSec });
  if (r.status === 201) {
    held[tenant]![kind] = r.json.secret;
    everSeen.add(r.json.secret);
  }
  return r;
}
const revoke = (tenant: string, kind: Kind, email = adminOf(tenant)) =>
  admin(email, "POST", `/admin/${tenant}/keys/${kind}/revoke-previous`);

// Probes. Each sends something signed with `secret` and says what we answered.
let n = 0;
const fresh = (p: string) => `${p}-${++n}-${randomUUID().slice(0, 6)}`;
async function alphaEvent(secret: string): Promise<number> {
  const body = alphaDeposit(fresh("evt"), fresh("pl"));
  const r = await fetch(`${app().url}/webhooks/${ALPHA}/events`, {
    method: "POST",
    headers: signAlpha(secret, body, now()),
    body,
  });
  return r.status;
}
async function betaEvent(secret: string): Promise<number> {
  const body = JSON.stringify({ transactions: [betaTxn(fresh("txn"), fresh("cu"))] });
  const r = await fetch(`${app().url}/webhooks/${BETA}/events`, {
    method: "POST",
    headers: signBeta(secret, body),
    body,
  });
  return r.status;
}
/** A result notice for a redemption that does not exist: a good signature gives 404, a bad one 401. */
async function betaNotice(secret: string): Promise<number> {
  const body = JSON.stringify({ requestId: "r1", externalRef: randomUUID(), state: "GRANTED" });
  const r = await fetch(`${app().url}/webhooks/${BETA}/rewards`, {
    method: "POST",
    headers: signBeta(secret, body),
    body,
  });
  return r.status;
}
async function meStatus(tenant: string, secret: string): Promise<number> {
  const token = tokenFor(tenant, secret, fresh("pl"), now());
  const r = await fetch(`${app().url}/me`, { headers: { authorization: `Bearer ${token}` } });
  return r.status;
}
const OK_EVENT = 200;
const BAD = 401;
const OK_NOTICE = 404;

describe.skipIf(!running)("event signing key: platform A", () => {
  test("1a. 0 seconds: the old secret is rejected at once, exactly like a bad signature; the new one works", async () => {
    const old = held[ALPHA]!.event_signing;
    const badBody = alphaDeposit(fresh("evt"), fresh("pl"));
    const bad = await fetch(`${app().url}/webhooks/${ALPHA}/events`, {
      method: "POST",
      headers: signAlpha("not-the-secret", badBody, now()),
      body: badBody,
    });
    const badText = await bad.text();
    expect(await alphaEvent(old)).toBe(OK_EVENT);
    const r = await rotate(ALPHA, "event_signing", 0);
    expect(r.status).toBe(201);
    expect(r.json.previous).toBeNull();
    const oldBody = alphaDeposit(fresh("evt"), fresh("pl"));
    const oldAnswer = await fetch(`${app().url}/webhooks/${ALPHA}/events`, {
      method: "POST",
      headers: signAlpha(old, oldBody, now()),
      body: oldBody,
    });
    expect(oldAnswer.status).toBe(bad.status);
    expect(await oldAnswer.text()).toBe(badText);
    expect(await alphaEvent(held[ALPHA]!.event_signing)).toBe(OK_EVENT);
  });

  test("2a. 3600 seconds: both work; after an hour the old one is rejected and the new one works", async () => {
    const old = held[ALPHA]!.event_signing;
    const r = await rotate(ALPHA, "event_signing", 3600);
    expect(r.status).toBe(201);
    const neu = held[ALPHA]!.event_signing;
    expect(r.json.previous.validUntil).toBe(new Date(now() + 3600_000).toISOString());
    expect(await alphaEvent(old)).toBe(OK_EVENT);
    expect(await alphaEvent(neu)).toBe(OK_EVENT);
    app().clock.advance(3599_000);
    expect(await alphaEvent(old)).toBe(OK_EVENT);
    app().clock.advance(1_000);
    expect(await alphaEvent(old)).toBe(BAD);
    expect(await alphaEvent(neu)).toBe(OK_EVENT);
    // The list stops reporting a previous key whose time has passed.
    const list = await admin(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/keys`);
    expect(list.json.find((k: { kind: string }) => k.kind === "event_signing").previous).toBeNull();
  });

  test("3a. 3600 seconds, then revoke the previous: the old one is rejected at once; a second revoke is still 200", async () => {
    const old = held[ALPHA]!.event_signing;
    expect((await rotate(ALPHA, "event_signing", 3600)).status).toBe(201);
    expect(await alphaEvent(old)).toBe(OK_EVENT);
    const first = await revoke(ALPHA, "event_signing");
    expect(first.status).toBe(200);
    expect(first.json.previous).toBeNull();
    expect(await alphaEvent(old)).toBe(BAD);
    expect(await alphaEvent(held[ALPHA]!.event_signing)).toBe(OK_EVENT);
    const second = await revoke(ALPHA, "event_signing");
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
  });
});

describe.skipIf(!running)("event signing key: platform B (events and result notices)", () => {
  test("1b. 0 seconds: the old secret fails for a deposit and for a notice; the new one works for both", async () => {
    const old = held[BETA]!.event_signing;
    expect(await betaEvent(old)).toBe(OK_EVENT);
    expect(await betaNotice(old)).toBe(OK_NOTICE);
    expect((await rotate(BETA, "event_signing", 0)).status).toBe(201);
    expect(await betaEvent(old)).toBe(BAD);
    expect(await betaNotice(old)).toBe(BAD);
    const neu = held[BETA]!.event_signing;
    expect(await betaEvent(neu)).toBe(OK_EVENT);
    expect(await betaNotice(neu)).toBe(OK_NOTICE);
  });

  test("2b. 3600 seconds: old and new both work for both, then only the new one after an hour", async () => {
    const old = held[BETA]!.event_signing;
    expect((await rotate(BETA, "event_signing", 3600)).status).toBe(201);
    const neu = held[BETA]!.event_signing;
    for (const s of [old, neu]) {
      expect(await betaEvent(s)).toBe(OK_EVENT);
      expect(await betaNotice(s)).toBe(OK_NOTICE);
    }
    app().clock.advance(3600_000);
    expect(await betaEvent(old)).toBe(BAD);
    expect(await betaNotice(old)).toBe(BAD);
    expect(await betaEvent(neu)).toBe(OK_EVENT);
    expect(await betaNotice(neu)).toBe(OK_NOTICE);
  });
});

describe.skipIf(!running)("player token key", () => {
  test("4a. 0 seconds: the old token secret is rejected at once, the new one works", async () => {
    const old = held[ALPHA]!.player_token;
    expect(await meStatus(ALPHA, old)).toBe(200);
    expect((await rotate(ALPHA, "player_token", 0)).status).toBe(201);
    expect(await meStatus(ALPHA, old)).toBe(401);
    expect(await meStatus(ALPHA, held[ALPHA]!.player_token)).toBe(200);
  });

  test("4b. 3600 seconds: both work, then only the new one after an hour", async () => {
    const old = held[ALPHA]!.player_token;
    expect((await rotate(ALPHA, "player_token", 3600)).status).toBe(201);
    const neu = held[ALPHA]!.player_token;
    expect(await meStatus(ALPHA, old)).toBe(200);
    expect(await meStatus(ALPHA, neu)).toBe(200);
    app().clock.advance(3600_000);
    expect(await meStatus(ALPHA, old)).toBe(401);
    expect(await meStatus(ALPHA, neu)).toBe(200);
  });

  test("4c. 3600 seconds then revoke-previous: the old one is rejected at once; revoke again is 200", async () => {
    const old = held[ALPHA]!.player_token;
    expect((await rotate(ALPHA, "player_token", 3600)).status).toBe(201);
    expect(await meStatus(ALPHA, old)).toBe(200);
    expect((await revoke(ALPHA, "player_token")).status).toBe(200);
    expect(await meStatus(ALPHA, old)).toBe(401);
    expect((await revoke(ALPHA, "player_token")).status).toBe(200);
    expect(await meStatus(ALPHA, held[ALPHA]!.player_token)).toBe(200);
  });
});

describe.skipIf(!running)("what a rotation must not touch", () => {
  test("5. another tenant and the other kind keep working", async () => {
    const betaEvents = held[BETA]!.event_signing;
    const alphaTokens = held[ALPHA]!.player_token;
    const alphaEvents = held[ALPHA]!.event_signing;
    expect((await rotate(ALPHA, "event_signing", 0)).status).toBe(201);
    expect(await betaEvent(betaEvents)).toBe(OK_EVENT);
    expect(await meStatus(ALPHA, alphaTokens)).toBe(200); // other kind
    expect(await alphaEvent(alphaEvents)).toBe(BAD);
    expect((await rotate(ALPHA, "player_token", 0)).status).toBe(201);
    expect(await alphaEvent(held[ALPHA]!.event_signing)).toBe(OK_EVENT); // other kind again
  });
});

describe.skipIf(!running)("who may do it", () => {
  test("6. roles", async () => {
    const path = `/admin/${ALPHA}/keys`;
    const body = { previousValidForSec: 60 };
    expect((await admin(ALPHA_VIEWER, "GET", path)).status).toBe(200);
    expect((await admin(ALPHA_VIEWER, "POST", `${path}/event_signing/rotate`, body)).status).toBe(403);
    expect((await admin(ALPHA_VIEWER, "POST", `${path}/event_signing/revoke-previous`)).status).toBe(403);
    expect((await admin(BETA_MANAGER, "GET", path)).status).toBe(404);
    expect((await admin(BETA_MANAGER, "POST", `${path}/event_signing/rotate`, body)).status).toBe(404);
    expect((await admin(BETA_MANAGER, "POST", `${path}/event_signing/revoke-previous`)).status).toBe(404);
    for (const [method, p] of [
      ["GET", path],
      ["POST", `${path}/event_signing/rotate`],
      ["POST", `${path}/event_signing/revoke-previous`],
    ] as const) {
      const r = await fetch(`${app().url}${p}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
      expect(r.status).toBe(401);
    }
    expect((await rotate(ALPHA, "event_signing", 60, OPS)).status).toBe(201);
    expect((await revoke(ALPHA, "event_signing", OPS)).status).toBe(200);
    expect((await admin(OPS, "GET", "/admin/no-such-tenant/keys")).status).toBe(404);
  });

  test("7. bad input is a 400; an unknown kind is a 404", async () => {
    const path = `/admin/${ALPHA}/keys/event_signing/rotate`;
    for (const bad of [-1, 86401, 1.5, "60", null, undefined]) {
      const r = await admin(ALPHA_MANAGER, "POST", path, { previousValidForSec: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin(ALPHA_MANAGER, "POST", path, {})).status).toBe(400);
    expect((await rotate(ALPHA, "event_signing", 86400)).status).toBe(201);
    expect((await rotate(ALPHA, "event_signing", 0)).status).toBe(201);
    const unknown = await admin(ALPHA_MANAGER, "POST", `/admin/${ALPHA}/keys/wheel/rotate`, {
      previousValidForSec: 0,
    });
    expect(unknown.status).toBe(404);
    expect((await admin(ALPHA_MANAGER, "POST", `/admin/${ALPHA}/keys/wheel/revoke-previous`)).status).toBe(
      404,
    );
  });
});

describe.skipIf(!running)("secrets stay secret", () => {
  test("8. the list shows hints only; no audit row and no log line holds any secret", async () => {
    for (const kind of ["event_signing", "player_token"] as const) {
      expect((await rotate(ALPHA, kind, 3600)).status).toBe(201);
      expect((await rotate(ALPHA, kind, 0)).status).toBe(201);
      expect((await rotate(ALPHA, kind, 3600)).status).toBe(201);
      expect((await revoke(ALPHA, kind)).status).toBe(200);
    }
    const list = await admin(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/keys`);
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(2);
    for (const k of list.json) {
      expect(Object.keys(k).sort()).toEqual(["hint", "kind", "previous", "rotatedAt"]);
      expect(k.hint).toMatch(/^.{4}….{4}$/);
    }
    const audit = (await app().db.query("SELECT * FROM audit_log")).rows.map((r) => JSON.stringify(r));
    expect(audit.length).toBeGreaterThan(10);
    // The scan is only worth something if the rotations are in the trail.
    expect(audit.some((a) => a.includes('"actor":"admin/'))).toBe(true);
    const rotations = (
      await app().db.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'tenants' AND action = 'update'",
      )
    ).rows[0].n;
    expect(rotations).toBeGreaterThanOrEqual(8);
    expect(app().logs.some((l) => l.event === "tenant.key_rotated")).toBe(true);
    expect(app().logs.some((l) => l.event === "tenant.key_previous_revoked")).toBe(true);
    const everything = [...audit, ...app().rawLogs, list.text];
    for (const secret of everSeen) {
      for (const text of everything)
        expect(text.includes(secret), `secret ${secret.slice(0, 6)}…`).toBe(false);
    }
    // The audit row names who did it.
    const who = (
      await app().db.query(
        "SELECT DISTINCT actor FROM audit_log WHERE entity_type = 'tenants' AND action = 'update'",
      )
    ).rows.map((r) => r.actor as string);
    expect(who.every((a) => a.startsWith("admin/"))).toBe(true);
  });
});

describe.skipIf(!running)("two replacements at once", () => {
  test("9. they run one after the other; one secret is current, the other is the previous one", async () => {
    const before = held[ALPHA]!.event_signing;
    const go = () =>
      admin(ALPHA_MANAGER, "POST", `/admin/${ALPHA}/keys/event_signing/rotate`, {
        previousValidForSec: 3600,
      });
    const [a, b] = await Promise.all([go(), go()]);
    // Choice: no conflict error. The tenant row is locked, so both succeed, one after the other.
    expect([a.status, b.status]).toEqual([201, 201]);
    const [sa, sb] = [a.json.secret as string, b.json.secret as string];
    everSeen.add(sa);
    everSeen.add(sb);
    expect(sa).not.toBe(sb);
    const list = await admin(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/keys`);
    const item = list.json.find((k: { kind: string }) => k.kind === "event_signing");
    const hintOf = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
    // The one that ran last is current; the one that ran first is its previous key. The old secret
    // from before both is gone (the second replacement moved the first's secret into "previous").
    const currentIsA = item.hint === hintOf(sa);
    const [current, previous] = currentIsA ? [sa, sb] : [sb, sa];
    expect(item.hint).toBe(hintOf(current));
    expect(item.previous.hint).toBe(hintOf(previous));
    expect(await alphaEvent(current)).toBe(OK_EVENT);
    expect(await alphaEvent(previous)).toBe(OK_EVENT);
    expect(await alphaEvent(before)).toBe(BAD);
    held[ALPHA]!.event_signing = current;
    // With a "0" in the mix the first one's key may be dead at once, and that is what its admin
    // asked for by the second call; exactly one secret is current and nothing else is valid.
    const zero = () =>
      admin(ALPHA_MANAGER, "POST", `/admin/${ALPHA}/keys/event_signing/rotate`, { previousValidForSec: 0 });
    const [c, d] = await Promise.all([zero(), zero()]);
    expect([c.status, d.status]).toEqual([201, 201]);
    const [sc, sd] = [c.json.secret as string, d.json.secret as string];
    everSeen.add(sc);
    everSeen.add(sd);
    const status = [await alphaEvent(sc), await alphaEvent(sd)];
    expect(status.filter((s) => s === OK_EVENT)).toHaveLength(1);
    expect(await alphaEvent(current)).toBe(BAD);
    held[ALPHA]!.event_signing = status[0] === OK_EVENT ? sc : sd;
  });
});
