import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hashPassword } from "../src/admin/password.ts";
import { create } from "../src/audit/audited.ts";
import { transaction } from "../src/db.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { demoOpsPolicy, demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { pickSegment } from "../src/wheel/pick-segment.ts";
import { ALPHA_MANAGER, ALPHA_VIEWER, BETA_MANAGER, OPS, adminHeaders, userIdOf } from "./admin-login.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { tokenFor } from "./signing.ts";

// Whole app over real HTTP, real PostgreSQL, real TigerBeetle, the fake casino as the platform.
const running = await startApp();
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const ALPHA = "alpha-casino";
const BETA = "beta-casino";
const tenantOf = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};
const app = () => {
  if (!running || !fake) throw new Error("no app");
  return running;
};

beforeAll(async () => {
  if (running && fake) await seedDemo(running.db, running.clock, fake.url);
});
afterAll(async () => {
  await fake?.close();
  await running?.close();
});

async function call(email: string, method: "GET" | "POST", path: string, body?: unknown) {
  const r = await fetch(`${app().url}${path}`, {
    method,
    headers: await adminHeaders(app(), email, { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const propose = (email: string, tenant: string, segments: unknown) =>
  call(email, "POST", `/admin/${tenant}/settings/wheel`, { segments });
const decide = (
  email: string,
  id: string,
  what: "approve" | "reject",
  note = "checked by the platform team",
) => call(email, "POST", `/platform/settings-changes/${id}/${what}`, { note });

/** Expected prize 16.25, well under the limit of 100. */
const CHEAP = [
  { label: "5 coins", coins: 5, weight: 3 },
  { label: "50 coins", coins: 50, weight: 1 },
];
/** Expected prize 500.5, above the limit of 100. */
const RICH = [
  { label: "1000 coins", coins: 1000, weight: 1 },
  { label: "1 coin", coins: 1, weight: 1 },
];

const versionsOf = async (tenant: string): Promise<number[]> =>
  (
    await app().db.query("SELECT version FROM wheel_configs WHERE tenant_id = $1 ORDER BY version", [tenant])
  ).rows.map((r) => r.version);
const newestVersion = async (tenant: string) => (await versionsOf(tenant)).at(-1) as number;
const auditOf = async (id: string) =>
  (await app().db.query("SELECT * FROM audit_log WHERE entity_id = $1 ORDER BY id", [id])).rows;

async function playerWheel(tenant: string, externalId = `p-${randomUUID()}`) {
  const token = tokenFor(tenant, tenantOf(tenant).tokenSecret, externalId, app().clock.now().getTime());
  const r = await fetch(`${app().url}/wheel`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
  return (await r.json()) as { version: number; segments: { label: string; coins: number }[] };
}

describe.skipIf(!running)("changing the wheel", () => {
  test("a wheel within the limit is applied at once; the player's wheel shows it", async () => {
    const before = await newestVersion(ALPHA);
    const r = await propose(ALPHA_MANAGER, ALPHA, CHEAP);
    expect(r.status).toBe(201);
    expect(r.json.wheelVersion).toBe(before + 1);
    expect(r.json.change).toMatchObject({
      status: "applied",
      kind: "wheel_config",
      tenantId: ALPHA,
      decidedBy: "policy/ops-v1",
      limitCoins: 100,
      expectedPrizeCoins: 16.25,
      proposedBy: `admin/${await userIdOf(app(), ALPHA_MANAGER)}`,
    });
    expect(r.json.change.resultId).toBeTruthy();
    const wheel = await playerWheel(ALPHA);
    expect(wheel.version).toBe(before + 1);
    expect(wheel.segments).toEqual([
      { label: "5 coins", coins: 5 },
      { label: "50 coins", coins: 50 },
    ]);
    // The other tenant's wheel is untouched.
    expect(await versionsOf(BETA)).toEqual([1]);
    expect((await playerWheel(BETA)).version).toBe(1);
  });

  test("a wheel above the limit waits; the player's wheel is unchanged; only the platform admin approves", async () => {
    const before = await newestVersion(ALPHA);
    const r = await propose(ALPHA_MANAGER, ALPHA, RICH);
    expect(r.status).toBe(202);
    expect(r.json.change).toMatchObject({
      status: "proposed",
      expectedPrizeCoins: 500.5,
      limitCoins: 100,
      decidedBy: null,
      resultId: null,
      decidedAt: null,
    });
    const id = r.json.change.id as string;
    expect(await newestVersion(ALPHA)).toBe(before);
    expect((await playerWheel(ALPHA)).version).toBe(before);

    // It is in the platform admin's list, with the tenant's id. Others cannot see the list.
    const waiting = await call(OPS, "GET", "/platform/settings-changes?status=proposed");
    expect(waiting.status).toBe(200);
    expect(waiting.json.map((c: { id: string }) => c.id)).toContain(id);
    expect((await call(ALPHA_MANAGER, "GET", "/platform/settings-changes?status=proposed")).status).toBe(403);
    expect((await call(ALPHA_VIEWER, "GET", "/platform/settings-changes")).status).toBe(403);
    expect((await call(OPS, "GET", "/platform/settings-changes?status=nope")).status).toBe(400);

    // The tenant's own admin cannot approve or reject. Nothing changed.
    for (const what of ["approve", "reject"] as const) {
      expect((await decide(ALPHA_MANAGER, id, what)).status).toBe(403);
      expect((await decide(ALPHA_VIEWER, id, what)).status).toBe(403);
    }
    expect(
      (
        await call(ALPHA_MANAGER, "POST", `/platform/settings-changes/${randomUUID()}/approve`, {
          note: "hello there",
        })
      ).status,
    ).toBe(403);
    expect(await newestVersion(ALPHA)).toBe(before);

    // The platform admin approves: applied, next version, the player sees it.
    const ok = await decide(OPS, id, "approve", "ok, the casino asked for a jackpot week");
    expect(ok.status).toBe(200);
    expect(ok.json.wheelVersion).toBe(before + 1);
    expect(ok.json.change).toMatchObject({
      status: "applied",
      decidedBy: `admin/${await userIdOf(app(), OPS)}`,
      decisionNote: "ok, the casino asked for a jackpot week",
    });
    expect((await playerWheel(ALPHA)).version).toBe(before + 1);
    const settings = await call(ALPHA_VIEWER, "GET", `/admin/${ALPHA}/settings`);
    expect(settings.json.wheel[0]).toMatchObject({ version: before + 1, expectedPrizeCoins: 500.5 });
    expect(settings.json.changes.find((c: { id: string }) => c.id === id)).toMatchObject({
      status: "applied",
    });
    expect(
      (await call(OPS, "GET", "/platform/settings-changes")).json.map((c: { id: string }) => c.id),
    ).not.toContain(id);

    // The alert for a wheel that pays too much fires now.
    const alerts = await call(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/alerts`);
    expect(alerts.json.alerts.map((a: { code: string }) => a.code)).toContain("wheel_expected_prize_high");
    const beta = await call(BETA_MANAGER, "GET", `/admin/${BETA}/alerts`);
    expect(beta.json.alerts.map((a: { code: string }) => a.code)).not.toContain("wheel_expected_prize_high");

    // Audit: who proposed, who decided, who created the wheel row.
    const rows = await auditOf(id);
    const manager = `admin/${await userIdOf(app(), ALPHA_MANAGER)}`;
    const ops = `admin/${await userIdOf(app(), OPS)}`;
    expect(rows.map((a) => [a.action, a.actor])).toEqual([
      ["create", manager],
      ["update", ops],
    ]);
    const wheelRows = await auditOf(ok.json.change.resultId);
    expect(wheelRows.map((a) => [a.action, a.actor, a.entity_type])).toEqual([
      ["create", ops, "wheel_configs"],
    ]);
  });

  test("reject: no new version; a second decision of any kind is 409", async () => {
    const before = await newestVersion(ALPHA);
    const id = (await propose(ALPHA_MANAGER, ALPHA, RICH)).json.change.id as string;
    const r = await decide(OPS, id, "reject", "too generous for this month");
    expect(r.status).toBe(200);
    expect(r.json.change).toMatchObject({
      status: "rejected",
      resultId: null,
      decisionNote: "too generous for this month",
    });
    expect(r.json.wheelVersion).toBeUndefined();
    expect(await newestVersion(ALPHA)).toBe(before);
    expect((await decide(OPS, id, "approve")).status).toBe(409);
    expect((await decide(OPS, id, "reject")).status).toBe(409);
    expect(await newestVersion(ALPHA)).toBe(before);

    // And the other way round.
    const id2 = (await propose(ALPHA_MANAGER, ALPHA, RICH)).json.change.id as string;
    expect((await decide(OPS, id2, "approve")).status).toBe(200);
    expect((await decide(OPS, id2, "reject")).status).toBe(409);
    expect((await decide(OPS, id2, "approve")).status).toBe(409);
    expect(await newestVersion(ALPHA)).toBe(before + 1);
  });

  test("approving twice at once applies once", async () => {
    const before = await newestVersion(BETA);
    const id = (await propose(BETA_MANAGER, BETA, RICH)).json.change.id as string;
    const answers = await Promise.all([1, 2, 3, 4].map(() => decide(OPS, id, "approve")));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await versionsOf(BETA)).toEqual(Array.from({ length: before + 1 }, (_, i) => i + 1));
    const applied = (await auditOf(id)).filter((a) => a.action === "update");
    expect(applied).toHaveLength(1);
  });

  test("changes applied at once from many requests get different, gapless versions", async () => {
    const before = await newestVersion(ALPHA);
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        propose(ALPHA_MANAGER, ALPHA, [
          { label: `a${i}`, coins: 1 + i, weight: 1 },
          { label: "b", coins: 2, weight: 1 },
        ]),
      ),
    );
    expect(answers.map((a) => a.status)).toEqual(Array(8).fill(201));
    const versions = answers.map((a) => a.json.wheelVersion as number).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 8 }, (_, i) => before + 1 + i));
    expect(await versionsOf(ALPHA)).toEqual(Array.from({ length: before + 8 }, (_, i) => i + 1));

    // Approvals of different waiting changes of one tenant, all at once, race the same way.
    const ids = await Promise.all(
      Array.from(
        { length: 5 },
        async () => (await propose(ALPHA_MANAGER, ALPHA, RICH)).json.change.id as string,
      ),
    );
    const base = await newestVersion(ALPHA);
    const approvals = await Promise.all(ids.map((id) => decide(OPS, id, "approve")));
    expect(approvals.map((a) => a.status)).toEqual(Array(5).fill(200));
    expect(approvals.map((a) => a.json.wheelVersion as number).sort((a, b) => a - b)).toEqual([
      base + 1,
      base + 2,
      base + 3,
      base + 4,
      base + 5,
    ]);
  });

  test("a viewer cannot propose; the platform admin can, for any tenant", async () => {
    expect((await propose(ALPHA_VIEWER, ALPHA, CHEAP)).status).toBe(403);
    expect((await propose(ALPHA_VIEWER, ALPHA, "garbage")).status).toBe(403); // the right is checked first
    expect((await propose(BETA_MANAGER, ALPHA, CHEAP)).status).toBe(404); // another tenant
    expect((await propose(OPS, "no-such-tenant", CHEAP)).status).toBe(404);
    const r = await propose(OPS, BETA, RICH);
    expect(r.status).toBe(202);
    expect(r.json.change.proposedBy).toBe(`admin/${await userIdOf(app(), OPS)}`);
    expect((await fetch(`${app().url}/admin/${ALPHA}/settings/wheel`, { method: "POST" })).status).toBe(401);
    await decide(OPS, r.json.change.id, "reject");
  });

  test("invalid segments are 400, one rule at a time", async () => {
    const ok = { label: "ok", coins: 10, weight: 1 };
    const bad: Record<string, unknown> = {
      "not a list": "segments",
      "no body field": undefined,
      "one segment": [ok],
      "25 segments": Array(25).fill(ok),
      "not an object": [ok, 5],
      "label missing": [ok, { coins: 1, weight: 1 }],
      "label empty": [ok, { ...ok, label: "" }],
      "label 41 chars": [ok, { ...ok, label: "x".repeat(41) }],
      "label a number": [ok, { ...ok, label: 7 }],
      "coins 0": [ok, { ...ok, coins: 0 }],
      "coins 1.5": [ok, { ...ok, coins: 1.5 }],
      "coins a string": [ok, { ...ok, coins: "10" }],
      "coins 1000001": [ok, { ...ok, coins: 1_000_001 }],
      "weight 0": [ok, { ...ok, weight: 0 }],
      "weight -1": [ok, { ...ok, weight: -1 }],
      "weight 1.5": [ok, { ...ok, weight: 1.5 }],
      "weight 1000001": [ok, { ...ok, weight: 1_000_001 }],
      "weight missing": [ok, { label: "x", coins: 1 }],
    };
    const before = await versionsOf(ALPHA);
    const waiting = (await call(OPS, "GET", "/platform/settings-changes")).json.length;
    for (const [name, segments] of Object.entries(bad)) {
      expect((await propose(ALPHA_MANAGER, ALPHA, segments)).status, name).toBe(400);
    }
    // The edges are fine: 2 and 24 segments, label of 40, coins and weight at the limits.
    const edge = [
      { label: "x".repeat(40), coins: 1_000_000, weight: 1 },
      { label: "y", coins: 1, weight: 1_000_000 },
    ];
    expect((await propose(ALPHA_MANAGER, ALPHA, edge)).status).toBe(201); // expected prize is tiny
    expect((await propose(ALPHA_MANAGER, ALPHA, Array(24).fill(ok))).status).toBe(201);
    expect((await versionsOf(ALPHA)).length).toBe(before.length + 2);
    expect((await call(OPS, "GET", "/platform/settings-changes")).json.length).toBe(waiting);
  });

  test("a bad decision body or id", async () => {
    const id = (await propose(ALPHA_MANAGER, ALPHA, RICH)).json.change.id as string;
    for (const note of [undefined, "", "abc", "x".repeat(501), 5]) {
      const r = await call(OPS, "POST", `/platform/settings-changes/${id}/approve`, { note });
      expect(r.status).toBe(400);
    }
    expect((await decide(OPS, randomUUID(), "approve")).status).toBe(404);
    expect((await decide(OPS, "not-an-id", "reject")).status).toBe(404);
    const still = await call(OPS, "GET", "/platform/settings-changes?status=proposed");
    expect(still.json.map((c: { id: string }) => c.id)).toContain(id);
    await decide(OPS, id, "reject");
  });

  test("the newest ops policy decides: a higher limit applies a rich wheel at once", async () => {
    await transaction(app().db, (tx) =>
      create(tx, { tenantId: BETA, actor: "system/test", now: app().clock.now() }, "ops_policies", {
        tenant_id: BETA,
        version: 2,
        params: { ...demoOpsPolicy, maxExpectedPrizeCoins: 1000 },
      }),
    );
    const r = await propose(BETA_MANAGER, BETA, RICH);
    expect(r.status).toBe(201);
    expect(r.json.change).toMatchObject({ decidedBy: "policy/ops-v2", limitCoins: 1000, status: "applied" });
    // Alpha still has the old limit.
    expect((await propose(ALPHA_MANAGER, ALPHA, RICH)).status).toBe(202);
  });

  test("a tenant without an ops policy: 409", async () => {
    const id = `t-${randomUUID().slice(0, 8)}`;
    const email = `m-${id}@test.local`;
    const hash = await hashPassword("some-long-password");
    await transaction(app().db, async (tx) => {
      const ctx = { tenantId: id, actor: "system/test", now: app().clock.now() };
      await create(tx, ctx, "tenants", {
        id,
        name: id,
        platform: "A",
        ledger_no: 900,
        webhook_secret: "w",
        token_secret: "t",
        wheel_secret: "s",
        platform_url: "http://127.0.0.1:1",
        platform_key: "k",
      });
      await create(tx, ctx, "wheel_configs", { tenant_id: id, version: 1, segments: CHEAP });
      await create(tx, ctx, "admin_users", {
        email,
        name: "No Policy",
        password_hash: hash,
        role: "tenant_admin",
        tenant_id: id,
      });
    });
    const login = await fetch(`${app().url}/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "some-long-password" }),
    });
    const token = ((await login.json()) as { token: string }).token;
    const r = await fetch(`${app().url}/admin/${id}/settings/wheel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ segments: CHEAP }),
    });
    expect(r.status).toBe(409);
    expect(await versionsOf(id)).toEqual([1]);
  });

  test("a spin granted before the change keeps its old wheel; a spin granted after uses the new one", async () => {
    const tenant = BETA;
    const secret = tenantOf(tenant).wheelSecret;
    const externalId = `p-${randomUUID()}`;
    const token = () =>
      tokenFor(tenant, tenantOf(tenant).tokenSecret, externalId, app().clock.now().getTime());
    const auth = () => ({ authorization: `Bearer ${token()}` });
    const deposit = async () => {
      const dep = await fetch(`${fake?.url}/control/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: tenant, playerId: externalId, amount: "20.00", currency: "EUR" }),
      });
      expect(dep.status).toBe(200);
    };
    const spins = async () =>
      (
        (await (await fetch(`${app().url}/me`, { headers: auth() })).json()) as {
          spins: { id: string; status: string }[];
        }
      ).spins;

    await deposit();
    const first = (await spins())[0]?.id as string;
    const oldWheel = (
      await app().db.query(
        "SELECT w.segments FROM spins s JOIN wheel_configs w ON w.id = s.wheel_config_id WHERE s.id = $1",
        [first],
      )
    ).rows[0].segments as { label: string; coins: number; weight: number }[];
    const expectedIndex = pickSegment(secret, first, oldWheel);

    // A new wheel where every segment pays 7 coins (expected prize 7, within the limit).
    const every7 = [
      { label: "seven", coins: 7, weight: 1 },
      { label: "seven too", coins: 7, weight: 1 },
    ];
    const changed = await propose(BETA_MANAGER, tenant, every7);
    expect(changed.status).toBe(201);

    await deposit();
    const second = (await spins()).find((s) => s.id !== first)?.id as string;

    const spin = (id: string) =>
      fetch(`${app().url}/wheel/spins/${id}/spin`, { method: "POST", headers: auth() }).then((r) => r.json());
    const a = (await spin(first)) as { segmentIndex: number; coins: number | string };
    const b = (await spin(second)) as { segmentIndex: number; coins: number | string };
    expect(a.segmentIndex).toBe(expectedIndex);
    expect(Number(a.coins)).toBe((oldWheel[expectedIndex] as { coins: number }).coins);
    expect(Number(b.coins)).toBe(7);
    const versions = (
      await app().db.query(
        "SELECT s.id, w.version FROM spins s JOIN wheel_configs w ON w.id = s.wheel_config_id WHERE s.id = ANY($1)",
        [[first, second]],
      )
    ).rows;
    const v = (id: string) => versions.find((x) => x.id === id)?.version as number;
    expect(v(second)).toBe(changed.json.wheelVersion);
    expect(v(first)).toBeLessThan(v(second));
  });

  test("the audit trail names the policy for an automatic apply and the person for a proposal", async () => {
    const r = await propose(ALPHA_MANAGER, ALPHA, CHEAP);
    const id = r.json.change.id as string;
    const person = `admin/${await userIdOf(app(), ALPHA_MANAGER)}`;
    const rows = await auditOf(id);
    expect(rows.map((a) => [a.action, a.actor])).toEqual([
      ["create", person],
      ["update", "policy/ops-v1"],
    ]);
    const wheel = await auditOf(r.json.change.resultId);
    expect(wheel.map((a) => [a.action, a.actor])).toEqual([["create", "policy/ops-v1"]]);
    // The tenant's manager can read it through the audit endpoint.
    const trail = await call(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/audit?entityId=${id}`);
    expect(trail.json.map((a: { actor: string }) => a.actor)).toEqual([person, "policy/ops-v1"]);
  });

  test("audit rows and settings changes carry the email of an admin actor, and null for any other actor", async () => {
    const r = await propose(ALPHA_MANAGER, ALPHA, RICH);
    const id = r.json.change.id as string;
    expect((await decide(OPS, id, "approve")).status).toBe(200);
    const trail = await call(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/audit?entityId=${id}`);
    expect(trail.json.map((a: { actorEmail: string | null }) => a.actorEmail)).toEqual([ALPHA_MANAGER, OPS]);
    const recent = await call(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/audit?recent=1&limit=100`);
    const system = recent.json.items.find((a: { actor: string }) => a.actor.startsWith("system/"));
    expect(system.actorEmail).toBeNull();
    const settings = await call(ALPHA_MANAGER, "GET", `/admin/${ALPHA}/settings`);
    const mine = settings.json.changes.find((c: { id: string }) => c.id === id);
    expect(mine).toMatchObject({ proposedByEmail: ALPHA_MANAGER, decidedByEmail: OPS });
    const auto = settings.json.changes.find((c: { decidedBy: string }) => c.decidedBy?.startsWith("policy/"));
    expect(auto).toMatchObject({ proposedByEmail: ALPHA_MANAGER, decidedByEmail: null });
    const waiting = await propose(ALPHA_MANAGER, ALPHA, RICH);
    const queue = await call(OPS, "GET", "/platform/settings-changes?status=proposed");
    const row = queue.json.find((c: { id: string }) => c.id === waiting.json.change.id);
    expect(row).toMatchObject({ proposedByEmail: ALPHA_MANAGER, decidedByEmail: null });
  });
});
