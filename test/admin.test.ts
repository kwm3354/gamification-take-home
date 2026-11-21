import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import type { FakeState } from "../src/fake-casino/state.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { ALPHA_MANAGER, BETA_MANAGER, OPS, adminHeaders, userIdOf } from "./admin-login.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { type JudgedPlayer, collect, judge } from "./judge.ts";
import { tokenFor } from "./signing.ts";

// Whole app over real HTTP, real PostgreSQL, real TigerBeetle, the fake casino as the platform.
// Skipped when no TigerBeetle is available.
const running = await startApp();
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const ALPHA = "alpha-casino";
const BETA = "beta-casino";
const tenantOf = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};

beforeAll(async () => {
  if (running && fake) await seedDemo(running.db, running.clock, fake.url);
});
afterAll(async () => {
  await fake?.close();
  await running?.close();
});

const app = () => {
  if (!running || !fake) throw new Error("no app");
  return running;
};
const fakeUrl = () => (fake as FakeCasino).url;
const outbox = () => app().app.get<Outbox>(OUTBOX);
const ledger = () => app().app.get<CoinLedger>(COIN_LEDGER);
const now = () => app().clock.now().getTime();

interface P extends JudgedPlayer {
  id: string;
}

const tokenOf = (p: { tenantId: string; externalId: string }) =>
  tokenFor(p.tenantId, tenantOf(p.tenantId).tokenSecret, p.externalId, now());

async function newPlayer(tenantId: string, coins: bigint): Promise<P> {
  const externalId = `p-${randomUUID()}`;
  const r = await fetch(`${app().url}/me`, {
    headers: { authorization: `Bearer ${tokenOf({ tenantId, externalId })}` },
  });
  const id = ((await r.json()) as { playerId: string }).playerId;
  if (coins > 0n) {
    await ledger().creditPrize({
      ledgerNo: tenantOf(tenantId).ledgerNo,
      playerId: id,
      spinId: randomUUID(),
      coins,
    });
  }
  return { tenantId, externalId, creditedCoins: coins, id };
}

async function itemId(tenantId: string, code: "bonus-5-eur" | "bonus-1-eur"): Promise<string> {
  const r = await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = $2", [
    tenantId,
    code,
  ]);
  return r.rows[0].id;
}

interface View {
  id: string;
  status: string;
  reason: string | null;
  platformRef: string | null;
  settled: boolean;
}

async function redeem(p: JudgedPlayer, item: string): Promise<View> {
  const r = await fetch(`${app().url}/store/redemptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenOf(p)}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ itemId: item }),
  });
  return (await r.json()) as View;
}

async function fault(point: string, kind: string, times = 1) {
  const r = await fetch(`${fakeUrl()}/control/faults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ point, fault: kind, times }),
  });
  expect(r.status).toBe(200);
}

async function deliver(): Promise<number> {
  const r = await fetch(`${fakeUrl()}/control/b/deliver`, { method: "POST" });
  return ((await r.json()) as { delivered: unknown[] }).delivered.length;
}

/** A call to the admin API, signed in as `as` (default: the manager of the tenant). */
async function admin(
  tenant: string,
  path: string,
  options: { method?: string; body?: unknown; as?: string } = {},
) {
  const as = options.as ?? (tenant === BETA ? BETA_MANAGER : ALPHA_MANAGER);
  const r = await fetch(`${app().url}/admin/${tenant}${path}`, {
    method: options.method ?? "GET",
    headers: await adminHeaders(app(), as, { "content-type": "application/json" }),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
}

const resolve = (tenant: string, id: string, outcome: string, note = "agreed with the casino") =>
  admin(tenant, `/redemptions/${id}/resolve`, { method: "POST", body: { outcome, note } });

const balanceOf = (p: P) => ledger().balance({ ledgerNo: tenantOf(p.tenantId).ledgerNo, playerId: p.id });
const auditOf = async (id: string) =>
  (await app().db.query("SELECT * FROM audit_log WHERE entity_id = $1 ORDER BY id", [id])).rows;
const grantsFor = async (reference: string) =>
  ((await (await fetch(`${fakeUrl()}/control/state`)).json()) as FakeState).grants.filter(
    (g) => g.reference === reference,
  );

/** A redemption on platform B that stays `submitting`: the grant is accepted and the callback is lost. */
async function stuckB(coins = 500n, lostRequest = false) {
  const p = await newPlayer(BETA, coins);
  if (lostRequest) await fault("b.grant", "lost_request");
  else await fault("b.callback", "lost");
  const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
  expect(r.status).toBe("submitting");
  await deliver();
  return { p, id: r.id };
}

beforeEach(async () => {
  if (!running || !fake) return;
  await fetch(`${fakeUrl()}/control/reset`, { method: "POST" });
  await running.db.query("UPDATE outbox SET done_at = now() WHERE done_at IS NULL");
  running.config.inlineJobs = true;
});

describe.skipIf(!running)("admin API", () => {
  test("1. auth: no token, a bad token and another tenant's manager are refused; the right manager works", async () => {
    const none = await fetch(`${app().url}/admin/${ALPHA}/alerts`);
    expect(none.status).toBe(401);
    const bad = await fetch(`${app().url}/admin/${ALPHA}/alerts`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
    expect((await admin(ALPHA, "/alerts", { as: BETA_MANAGER })).status).toBe(404);
    expect((await admin("no-such-tenant", "/alerts", { as: OPS })).status).toBe(404);
    expect((await admin(ALPHA, "/alerts")).status).toBe(200);
  });

  test("2. audit: the rows of a spin come oldest first; another tenant sees nothing", async () => {
    const external = `p-${randomUUID()}`;
    const dep = await fetch(`${fakeUrl()}/control/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: ALPHA, playerId: external, amount: "20.00", currency: "EUR" }),
    });
    expect(dep.status).toBe(200);
    const token = tokenFor(ALPHA, tenantOf(ALPHA).tokenSecret, external, now());
    const me = (await (
      await fetch(`${app().url}/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { spins: { id: string }[] };
    const spinId = me.spins[0]?.id as string;
    const spun = await fetch(`${app().url}/wheel/spins/${spinId}/spin`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(spun.status).toBe(200);

    const mine = await admin(ALPHA, `/audit?entityId=${spinId}`);
    expect(mine.status).toBe(200);
    const rows = mine.json as { id: number; actor: string; action: string; entityType: string; at: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
    expect(rows[0]).toMatchObject({ action: "create", entityType: "spins" });
    expect(rows.some((r) => r.action === "update" && r.actor.startsWith("player/"))).toBe(true);
    expect(rows.some((r) => r.actor === "system/outbox")).toBe(true);

    expect((await admin(BETA, `/audit?entityId=${spinId}`)).json).toEqual([]);
    expect((await admin(ALPHA, "/audit")).status).toBe(400);
  });

  test("3. stuck: a redemption without a final answer is listed only after the limit; the other tenant has none", async () => {
    const { id } = await stuckB();
    const before = await admin(BETA, "/redemptions/stuck");
    expect(before.json.limitSec).toBe(300);
    expect(before.json.items.find((i: { id: string }) => i.id === id)).toBeUndefined();

    app().clock.advance(301_000);
    await fault("b.find", "error_500", 20);
    await outbox().runDue(); // the look fails, so it cannot resolve itself
    const after = await admin(BETA, "/redemptions/stuck");
    const item = after.json.items.find((i: { id: string }) => i.id === id);
    expect(item).toMatchObject({
      status: "submitting",
      settled: false,
      costCoins: "100",
      ageSec: 301,
    });
    expect(item.platformRef).toMatch(/^r_/);
    expect(item.lastPlatformCall).toMatchObject({ call: "find" });
    expect(item.lastPlatformCall.error).toBeTruthy();
    expect(after.json.items.map((i: { ageSec: number }) => i.ageSec)).toEqual(
      after.json.items.map((i: { ageSec: number }) => i.ageSec).sort((a: number, b: number) => b - a),
    );
    expect((await admin(ALPHA, "/redemptions/stuck")).json.items).toEqual([]);
  });

  test("4. resolve as issued: final, coins debited once, audit names the admin; the judge sees the cost", async () => {
    const { p, id } = await stuckB(500n, true); // the grant call was lost: the casino has no grant
    expect(await grantsFor(id)).toHaveLength(0);
    const dana = `admin/${await userIdOf(app(), BETA_MANAGER)}`;
    const r = await resolve(BETA, id, "issued", "casino confirmed by email");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, status: "issued", platformRef: "manual", settled: true });
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });

    const rows = await auditOf(id);
    const manual = rows.filter((a) => a.action === "manual_resolution");
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({
      actor: dana,
      entity_type: "redemption",
      tenant_id: BETA,
      changes: { outcome: "issued", note: "casino confirmed by email" },
    });
    const statusUpdate = rows.find(
      (a) =>
        a.action === "update" &&
        (a.changes as { field: string; to: unknown }[]).some(
          (c) => c.field === "status" && c.to === "issued",
        ),
    );
    expect(statusUpdate?.actor).toBe(dana);

    // The honest cost of a manual decision: our books say issued, the casino has nothing.
    const problems = judge(await collect(app(), { url: fakeUrl() }, [p]));
    expect(problems.some((x) => x.includes(`${id} is shown as issued but the casino has no grant`))).toBe(
      true,
    );
    // The same endpoint shows the trail.
    const trail = await admin(BETA, `/audit?entityId=${id}`);
    expect(trail.json.some((a: { action: string }) => a.action === "manual_resolution")).toBe(true);
  });

  test("5. resolve as refused: the coins come back in full and the redemption is settled", async () => {
    const { p, id } = await stuckB();
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 100n });
    const r = await resolve(BETA, id, "refused", "casino says the player is blocked");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      status: "refused",
      reason: "manual: casino says the player is blocked",
      settled: true,
    });
    expect(await balanceOf(p)).toEqual({ available: 500n, reserved: 0n });
  });

  test("6. not resolvable: final, insufficient, created, resolved twice, other tenant, bad body", async () => {
    // final (platform A issues at once)
    const a = await newPlayer(ALPHA, 500n);
    const issued = await redeem(a, await itemId(ALPHA, "bonus-1-eur"));
    expect(issued.status).toBe("issued");
    const onFinal = await resolve(ALPHA, issued.id, "refused");
    expect(onFinal.status).toBe(409);
    expect(onFinal.json.view).toMatchObject({ id: issued.id, status: "issued" });

    // insufficient
    const poor = await newPlayer(BETA, 0n);
    const none = await redeem(poor, await itemId(BETA, "bonus-1-eur"));
    expect(none.status).toBe("insufficient");
    expect((await resolve(BETA, none.id, "issued")).status).toBe(409);

    // created: the process "died" before the first step
    app().config.inlineJobs = false;
    const b = await newPlayer(BETA, 500n);
    const created = await redeem(b, await itemId(BETA, "bonus-1-eur"));
    app().config.inlineJobs = true;
    expect(created.status).toBe("created");
    expect((await resolve(BETA, created.id, "issued")).status).toBe(409);

    // resolved twice
    const { id } = await stuckB();
    expect((await resolve(BETA, id, "refused")).status).toBe(200);
    const again = await resolve(BETA, id, "refused");
    expect(again.status).toBe(409);
    expect(again.json.view.status).toBe("refused");
    expect((await auditOf(id)).filter((r) => r.action === "manual_resolution")).toHaveLength(1);

    // another tenant's redemption, and ids that do not exist
    const other = await stuckB();
    expect((await resolve(ALPHA, other.id, "refused")).status).toBe(404);
    expect((await resolve(BETA, randomUUID(), "refused")).status).toBe(404);
    expect((await resolve(BETA, "not-an-id", "refused")).status).toBe(404);
    expect((await auditOf(other.id)).some((r) => r.action === "manual_resolution")).toBe(false);

    // bad body
    expect((await resolve(BETA, other.id, "refused", "")).status).toBe(400);
    expect((await resolve(BETA, other.id, "refused", "abc")).status).toBe(400);
    expect((await resolve(BETA, other.id, "refused", "x".repeat(501))).status).toBe(400);
    expect((await resolve(BETA, other.id, "maybe")).status).toBe(400);
    expect((await admin(BETA, `/redemptions/${other.id}/resolve`, { method: "POST", body: {} })).status).toBe(
      400,
    );
  });

  test("7. a late real answer that contradicts the manual one is recorded and alerted; one that agrees is not", async () => {
    // The casino accepts the grant; its callback waits until the test delivers it.
    const waiting = await newPlayer(BETA, 500n);
    const w = await redeem(waiting, await itemId(BETA, "bonus-1-eur"));
    expect(w.status).toBe("submitting");
    expect((await resolve(BETA, w.id, "refused", "we think the casino refused")).status).toBe(200);
    expect(await balanceOf(waiting)).toEqual({ available: 500n, reserved: 0n });
    expect(await deliver()).toBeGreaterThanOrEqual(1); // the casino now says GRANTED
    const after = await admin(BETA, `/audit?entityId=${w.id}`);
    const contradictions = after.json.filter((a: { action: string }) => a.action === "outcome_contradicted");
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].changes).toMatchObject({ final: "refused", late: "issued" });
    expect(contradictions[0].changes.platformRef).toMatch(/^r_/);
    const row = (await app().db.query("SELECT status, settled_at FROM redemptions WHERE id = $1", [w.id]))
      .rows[0];
    expect(row.status).toBe("refused");
    expect(row.settled_at).not.toBeNull();
    expect(await balanceOf(waiting)).toEqual({ available: 500n, reserved: 0n });
    expect(await grantsFor(w.id)).toHaveLength(1); // the casino did grant: the alert is why we look

    const alerts = await admin(BETA, "/alerts");
    const alert = alerts.json.alerts.find((x: { code: string }) => x.code === "outcome_contradicted");
    expect(alert).toMatchObject({ severity: "critical", subject: BETA });
    expect(alert.detail.redemptionIds).toContain(w.id);

    // A late answer that agrees: resolve as issued, then the casino says GRANTED. Nothing new.
    const agree = await newPlayer(BETA, 500n);
    const g = await redeem(agree, await itemId(BETA, "bonus-1-eur"));
    expect((await resolve(BETA, g.id, "issued", "casino confirmed the grant")).status).toBe(200);
    const rowsBefore = (await auditOf(g.id)).length;
    expect(await deliver()).toBeGreaterThanOrEqual(1);
    expect((await auditOf(g.id)).length).toBe(rowsBefore);
    expect((await auditOf(g.id)).some((r) => r.action === "outcome_contradicted")).toBe(false);
  });

  test("8. the real answer and a manual resolution at the same moment: exactly one wins, the ledger is settled once", async () => {
    let adminWins = 0;
    let webhookWins = 0;
    for (let i = 0; i < 24; i++) {
      const p = await newPlayer(BETA, 500n);
      const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
      expect(r.status).toBe("submitting");
      const outcome = i % 2 === 0 ? "refused" : "issued";
      // The admin call starts 0..5 ms after the delivery: this varies who gets to the row first.
      // It is not a wait for anything; both calls are awaited below.
      const lag = i % 6;
      const [, answer] = await Promise.all([
        deliver(),
        (lag === 0 ? Promise.resolve() : new Promise((go) => setTimeout(go, lag))).then(() =>
          resolve(BETA, r.id, outcome, "racing the casino"),
        ),
      ]);
      await outbox().runDue();

      const rows = await auditOf(r.id);
      const won = rows.filter(
        (a) =>
          a.action === "update" &&
          (a.changes as { field: string; to: unknown }[]).some(
            (c) => c.field === "status" && (c.to === "issued" || c.to === "refused"),
          ),
      );
      expect(won).toHaveLength(1); // one status change to a final status, ever
      const manual = rows.filter((a) => a.action === "manual_resolution");
      const row = (await app().db.query("SELECT status, settled_at FROM redemptions WHERE id = $1", [r.id]))
        .rows[0];
      expect(row.settled_at).not.toBeNull();
      if (manual.length === 1) {
        adminWins++;
        expect(answer.status).toBe(200);
        expect(won[0]?.actor).toBe(`admin/${await userIdOf(app(), BETA_MANAGER)}`);
        expect(row.status).toBe(outcome);
      } else {
        webhookWins++;
        expect(manual).toHaveLength(0);
        expect(answer.status).toBe(409);
        expect(row.status).toBe("issued"); // the casino's GRANTED
      }
      const contradicted = rows.filter((a) => a.action === "outcome_contradicted").length;
      expect(contradicted).toBe(manual.length === 1 && outcome === "refused" ? 1 : 0);
      // Never both captured and released: the balance is exactly one of the two.
      expect(await balanceOf(p)).toEqual(
        row.status === "issued" ? { available: 400n, reserved: 0n } : { available: 500n, reserved: 0n },
      );
    }
    expect(adminWins + webhookWins).toBe(24);
  });
});
