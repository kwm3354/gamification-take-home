import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadOpsPolicy, validateOpsParams } from "../src/alerts/ops-policy.ts";
import { create, record } from "../src/audit/audited.ts";
import { transaction } from "../src/db.ts";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { demoOpsPolicy, demoTenants, demoWheelSegments } from "../src/tenants/demo-tenants.ts";
import { findOrCreatePlayer } from "../src/tenants/players.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { tokenFor } from "./signing.ts";

// Whole app over real HTTP for the alerts endpoint, real PostgreSQL, real TigerBeetle. Most data is
// written through the audited functions into a fresh tenant of its own, so tests do not meet.
// Skipped when no TigerBeetle is available.
const running = await startApp();
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const BETA = "beta-casino";
const beta = demoTenants.find((d) => d.id === BETA);

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
const ctx = (tenantId: string, actor = "system/test") => ({ tenantId, actor, now: app().clock.now() });

interface AlertView {
  code: string;
  severity: string;
  subject: string;
  value: number;
  limit: number;
  detail: Record<string, unknown>;
}
interface AlertsAnswer {
  at: string;
  policyVersion: number | null;
  alerts: AlertView[];
}

let nextLedger = 100;
/** A fresh tenant with the demo wheel (expected prize 60) and the demo ops policy as version 1. */
async function newTenant(options: { policy?: boolean } = {}): Promise<{ id: string; adminKey: string }> {
  const id = `t-${randomUUID().slice(0, 8)}`;
  const adminKey = `key-${id}`;
  await transaction(app().db, async (tx) => {
    const c = ctx(id);
    await create(tx, c, "tenants", {
      id,
      name: id,
      platform: "A",
      ledger_no: nextLedger++,
      webhook_secret: "w",
      token_secret: "t",
      wheel_secret: "s",
      admin_key: adminKey,
      platform_url: "http://127.0.0.1:1",
      platform_key: "k",
    });
    await create(tx, c, "wheel_configs", { tenant_id: id, version: 1, segments: demoWheelSegments });
    if (options.policy !== false) {
      await create(tx, c, "ops_policies", { tenant_id: id, version: 1, params: demoOpsPolicy });
    }
  });
  return { id, adminKey };
}

async function alertsOf(t: { id: string; adminKey: string }): Promise<AlertsAnswer> {
  const r = await fetch(`${app().url}/admin/${t.id}/alerts`, { headers: { "x-admin-key": t.adminKey } });
  expect(r.status).toBe(200);
  return (await r.json()) as AlertsAnswer;
}
const codes = (a: AlertsAnswer) => a.alerts.map((x) => x.code);

async function setPolicy(t: { id: string }, version: number, changes: Record<string, number>) {
  await transaction(app().db, (tx) =>
    create(tx, ctx(t.id), "ops_policies", {
      tenant_id: t.id,
      version,
      params: { ...demoOpsPolicy, ...changes },
    }),
  );
}

async function newWheel(t: { id: string }, version: number, segments: unknown) {
  await transaction(app().db, (tx) =>
    create(tx, ctx(t.id), "wheel_configs", { tenant_id: t.id, version, segments }),
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** `n` spins of one player, from one deposit event received `ageMs` ago; `coins` null leaves them unused. */
async function addSpins(
  t: { id: string },
  externalId: string,
  n: number,
  options: { coins?: number; ageMs?: number } = {},
) {
  const at = new Date(app().clock.now().getTime() - (options.ageMs ?? 0));
  await transaction(app().db, async (tx) => {
    const c = { ...ctx(t.id), now: at };
    const player = await findOrCreatePlayer(tx, c, t.id, externalId);
    const wheel = await tx.query(
      "SELECT id FROM wheel_configs WHERE tenant_id = $1 ORDER BY version LIMIT 1",
      [t.id],
    );
    const event = await create(tx, c, "inbound_events", {
      tenant_id: t.id,
      external_event_id: `e-${randomUUID()}`,
      kind: "deposit_succeeded",
      player_id: player.id,
      normalized: {},
      raw: {},
      received_at: at,
    });
    for (let ordinal = 1; ordinal <= n; ordinal++) {
      await create(tx, c, "spins", {
        tenant_id: t.id,
        player_id: player.id,
        source_event_id: event?.id,
        ordinal,
        wheel_config_id: wheel.rows[0].id,
        ...(options.coins === undefined
          ? {}
          : { status: "used", segment_index: 0, coins: options.coins, used_at: at, credited_at: at }),
      });
    }
  });
}

/** An issued redemption of `coins` for the player, created `ageMs` ago (written directly, no platform). */
async function addIssued(t: { id: string }, externalId: string, coins: number, ageMs = 0) {
  const at = new Date(app().clock.now().getTime() - ageMs);
  await transaction(app().db, async (tx) => {
    const c = { ...ctx(t.id), now: at };
    const player = await findOrCreatePlayer(tx, c, t.id, externalId);
    const item = await create(tx, c, "store_items", {
      tenant_id: t.id,
      code: `i-${randomUUID().slice(0, 8)}`,
      name: "item",
      cost_coins: coins,
      reward: { type: "bonus", amountMinor: coins, currency: "EUR" },
    });
    await create(tx, c, "redemptions", {
      tenant_id: t.id,
      player_id: player.id,
      idempotency_key: randomUUID(),
      item_id: item?.id,
      cost_coins: coins,
      reward: { type: "bonus", amountMinor: coins, currency: "EUR" },
      status: "issued",
      settled_at: at,
      created_at: at,
      updated_at: at,
    });
  });
}

describe.skipIf(!running)("alerts", () => {
  test("a quiet tenant has no alerts, and the answer names the policy version and the time", async () => {
    const t = await newTenant();
    const a = await alertsOf(t);
    expect(a.alerts).toEqual([]);
    expect(a.policyVersion).toBe(1);
    expect(a.at).toBe(app().clock.now().toISOString());
  });

  test("no ops policy: one critical alert instead of an error", async () => {
    const t = await newTenant({ policy: false });
    await addSpins(t, "p-1", 500); // data that would fire alerts is not looked at without thresholds
    const a = await alertsOf(t);
    expect(a.policyVersion).toBeNull();
    expect(a.alerts).toHaveLength(1);
    expect(a.alerts[0]).toMatchObject({ code: "no_ops_policy", severity: "critical", subject: t.id });
  });

  test("redemption_pending_too_long: age decides, not errors; the limit comes from the policy", async () => {
    const adminKey = beta?.adminKey ?? "";
    const tenant = { id: BETA, adminKey };
    const ledger = app().app.get<CoinLedger>(COIN_LEDGER);
    const external = `p-${randomUUID()}`;
    const token = () => tokenFor(BETA, beta?.tokenSecret ?? "", external, app().clock.now().getTime());
    const me = (await (
      await fetch(`${app().url}/me`, { headers: { authorization: `Bearer ${token()}` } })
    ).json()) as { playerId: string };
    await ledger.creditPrize({
      ledgerNo: beta?.ledgerNo ?? 0,
      playerId: me.playerId,
      spinId: randomUUID(),
      coins: 500n,
    });
    const item = (
      await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = 'bonus-1-eur'", [BETA])
    ).rows[0].id;
    // The casino accepts the grant and then goes silent: no error anywhere.
    await fetch(`${fake?.url}/control/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ point: "b.callback", fault: "lost", times: 1 }),
    });
    const r = await fetch(`${app().url}/store/redemptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ itemId: item }),
    });
    const view = (await r.json()) as { id: string; status: string };
    expect(view.status).toBe("submitting");
    await fetch(`${fake?.url}/control/b/deliver`, { method: "POST" });

    expect(codes(await alertsOf(tenant))).not.toContain("redemption_pending_too_long");
    app().clock.advance(301_000);
    const fired = (await alertsOf(tenant)).alerts.find((x) => x.code === "redemption_pending_too_long");
    expect(fired).toMatchObject({ severity: "critical", subject: BETA, value: 301, limit: 300 });
    expect(fired?.detail).toMatchObject({ count: 1, ids: [view.id] });

    // Another tenant has no such redemption.
    const other = await newTenant();
    expect(codes(await alertsOf(other))).not.toContain("redemption_pending_too_long");

    // A longer limit in policy version 2 makes it quiet.
    await transaction(app().db, (tx) =>
      create(tx, ctx(BETA), "ops_policies", {
        tenant_id: BETA,
        version: 2,
        params: { ...demoOpsPolicy, pendingAgeLimitSec: 3600 },
      }),
    );
    const quiet = await alertsOf(tenant);
    expect(quiet.policyVersion).toBe(2);
    expect(codes(quiet)).not.toContain("redemption_pending_too_long");

    // An admin resolves it by hand, and with the old limit back it is no longer pending.
    await transaction(app().db, (tx) =>
      create(tx, ctx(BETA), "ops_policies", { tenant_id: BETA, version: 3, params: demoOpsPolicy }),
    );
    expect(codes(await alertsOf(tenant))).toContain("redemption_pending_too_long");
    const res = await fetch(`${app().url}/admin/${BETA}/redemptions/${view.id}/resolve`, {
      method: "POST",
      headers: { "x-admin-key": adminKey, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "issued", note: "confirmed by the casino" }),
    });
    expect(res.status).toBe(200);
    expect(codes(await alertsOf(tenant))).not.toContain("redemption_pending_too_long");
  });

  test("outbox_dead_jobs: counts dead jobs of this tenant only", async () => {
    const t = await newTenant();
    const other = await newTenant();
    await app().db.query(
      "INSERT INTO outbox (tenant_id, kind, ref_id, run_at, attempts, dead_at) VALUES ($1, 'spin_credit', $2, now(), 10, now())",
      [t.id, randomUUID()],
    );
    await app().db.query(
      "INSERT INTO outbox (tenant_id, kind, ref_id, run_at, attempts) VALUES ($1, 'spin_credit', $2, now(), 3)",
      [t.id, randomUUID()],
    );
    const a = (await alertsOf(t)).alerts.find((x) => x.code === "outbox_dead_jobs");
    expect(a).toMatchObject({ severity: "critical", subject: t.id, value: 1, limit: 0 });
    expect(codes(await alertsOf(other))).not.toContain("outbox_dead_jobs");
  });

  test("wheel_expected_prize_high: the newest wheel is compared with the limit of the policy", async () => {
    const t = await newTenant();
    const other = await newTenant();
    expect(codes(await alertsOf(t))).not.toContain("wheel_expected_prize_high"); // demo wheel: 60 <= 100
    await newWheel(t, 2, [
      { label: "100", coins: 100, weight: 50 },
      { label: "500", coins: 500, weight: 50 },
    ]);
    const a = (await alertsOf(t)).alerts.find((x) => x.code === "wheel_expected_prize_high");
    expect(a).toMatchObject({ severity: "warning", subject: t.id, value: 300, limit: 100 });
    expect(codes(await alertsOf(other))).not.toContain("wheel_expected_prize_high");
    // Exactly at the limit is fine: expected 100 with weights 1:1 of 50 and 150.
    await newWheel(t, 3, [
      { label: "50", coins: 50, weight: 1 },
      { label: "150", coins: 150, weight: 1 },
    ]);
    expect(codes(await alertsOf(t))).not.toContain("wheel_expected_prize_high");
    // One coin more in total is above it (exact integers, no rounding).
    await newWheel(t, 4, [
      { label: "50", coins: 50, weight: 3 },
      { label: "151", coins: 151, weight: 3 },
    ]);
    expect(codes(await alertsOf(t))).toContain("wheel_expected_prize_high");
    // A higher limit in policy version 2 silences it.
    await setPolicy(t, 2, { maxExpectedPrizeCoins: 120 });
    expect(codes(await alertsOf(t))).not.toContain("wheel_expected_prize_high");
  });

  test("wheel_paying_above_expectation: needs 200 used spins in 24 hours and a mean 25 percent above", async () => {
    const t = await newTenant();
    const other = await newTenant();
    await addSpins(t, "p-lucky", 199, { coins: 500 });
    expect(codes(await alertsOf(t))).not.toContain("wheel_paying_above_expectation"); // too few spins
    await addSpins(t, "p-lucky", 51, { coins: 500 }); // 250 spins, mean 500, expected 60
    const a = (await alertsOf(t)).alerts.find((x) => x.code === "wheel_paying_above_expectation");
    expect(a).toMatchObject({ severity: "warning", subject: t.id, value: 500 });
    expect(a?.detail).toMatchObject({ spins: 250, expectedMeanPrize: 60 });
    expect(codes(await alertsOf(other))).not.toContain("wheel_paying_above_expectation");

    const fair = await newTenant();
    await addSpins(fair, "p-1", 250, { coins: 60 }); // exactly the expectation
    expect(codes(await alertsOf(fair))).not.toContain("wheel_paying_above_expectation");
    const edge = await newTenant();
    await addSpins(edge, "p-1", 250, { coins: 75 }); // exactly 25 percent above: not more than
    expect(codes(await alertsOf(edge))).not.toContain("wheel_paying_above_expectation");
    const over = await newTenant();
    await addSpins(over, "p-1", 250, { coins: 76 });
    expect(codes(await alertsOf(over))).toContain("wheel_paying_above_expectation");

    // Spins used more than 24 hours ago do not count.
    const old = await newTenant();
    await addSpins(old, "p-1", 250, { coins: 500, ageMs: 25 * HOUR });
    expect(codes(await alertsOf(old))).not.toContain("wheel_paying_above_expectation");
  });

  test("many_spins_one_player: one alert per player over the limit; the limit comes from the policy", async () => {
    const t = await newTenant();
    const other = await newTenant();
    await addSpins(t, "p-loop", 21);
    await addSpins(t, "p-fine", 20); // exactly the limit
    await addSpins(t, "p-old", 30, { ageMs: 25 * HOUR }); // outside the window
    await addSpins(other, "p-loop", 5);
    const a = await alertsOf(t);
    const spins = a.alerts.filter((x) => x.code === "many_spins_one_player");
    expect(spins).toHaveLength(1);
    expect(spins[0]).toMatchObject({ severity: "warning", subject: "player/p-loop", value: 21, limit: 20 });
    expect(codes(await alertsOf(other))).not.toContain("many_spins_one_player");

    await setPolicy(t, 2, { maxSpinsPerPlayerPerDay: 10 });
    const strict = (await alertsOf(t)).alerts.filter((x) => x.code === "many_spins_one_player");
    expect(strict.map((x) => x.subject).sort()).toEqual(["player/p-fine", "player/p-loop"]);
    await setPolicy(t, 3, { maxSpinsPerPlayerPerDay: 30 });
    expect(codes(await alertsOf(t))).not.toContain("many_spins_one_player");
  });

  test("player_redeem_share_high: a big share fires only when the tenant total is large enough", async () => {
    const t = await newTenant();
    const other = await newTenant();
    await addIssued(t, "p-whale", 800);
    await addIssued(t, "p-small", 300); // total 1100 >= 1000; whale has 72.7 percent
    const a = (await alertsOf(t)).alerts.filter((x) => x.code === "player_redeem_share_high");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: "warning", subject: "player/p-whale", limit: 0.5 });
    expect(a[0]?.value).toBeCloseTo(800 / 1100, 5);
    expect(codes(await alertsOf(other))).not.toContain("player_redeem_share_high");

    const small = await newTenant();
    await addIssued(small, "p-whale", 600);
    await addIssued(small, "p-small", 300); // total 900 < 1000: too little to judge
    expect(codes(await alertsOf(small))).not.toContain("player_redeem_share_high");
    await setPolicy(small, 2, { minRedeemedForShare: 500 });
    expect(codes(await alertsOf(small))).toContain("player_redeem_share_high");
    await setPolicy(small, 3, { minRedeemedForShare: 500, maxPlayerRedeemShare: 0.7 }); // 66.7 percent <= 70
    expect(codes(await alertsOf(small))).not.toContain("player_redeem_share_high");

    // Exactly the limit is fine: two players with half each, limit 0.5, "more than".
    const half = await newTenant();
    await addIssued(half, "p-1", 600);
    await addIssued(half, "p-2", 600);
    expect(codes(await alertsOf(half))).not.toContain("player_redeem_share_high");

    const old = await newTenant();
    await addIssued(old, "p-whale", 5000, 25 * HOUR);
    expect(codes(await alertsOf(old))).not.toContain("player_redeem_share_high");
  });

  test("outcome_contradicted: any such audit row in 24 hours is critical, and it ages out", async () => {
    const t = await newTenant();
    const other = await newTenant();
    const id = randomUUID();
    await transaction(app().db, (tx) =>
      record(tx, ctx(t.id, `platform/${t.id}`), {
        action: "outcome_contradicted",
        entityType: "redemption",
        entityId: id,
        changes: { final: "refused", late: "issued", platformRef: "r_1" },
      }),
    );
    const a = (await alertsOf(t)).alerts.find((x) => x.code === "outcome_contradicted");
    expect(a).toMatchObject({ severity: "critical", subject: t.id, value: 1 });
    expect(a?.detail).toMatchObject({ redemptionIds: [id] });
    expect(codes(await alertsOf(other))).not.toContain("outcome_contradicted");
    app().clock.advance(25 * HOUR);
    expect(codes(await alertsOf(t))).not.toContain("outcome_contradicted");
  });

  test("the alerts endpoint answers 401 without the tenant's admin key", async () => {
    const t = await newTenant();
    const r = await fetch(`${app().url}/admin/${t.id}/alerts`);
    expect(r.status).toBe(401);
  });
});

describe("ops policy", () => {
  const ok = { ...demoOpsPolicy };
  const bad: [string, Record<string, unknown>][] = [
    ["pendingAgeLimitSec below 10", { pendingAgeLimitSec: 9 }],
    ["pendingAgeLimitSec above a day", { pendingAgeLimitSec: 86_401 }],
    ["pendingAgeLimitSec not whole", { pendingAgeLimitSec: 30.5 }],
    ["maxExpectedPrizeCoins zero", { maxExpectedPrizeCoins: 0 }],
    ["maxExpectedPrizeCoins a string", { maxExpectedPrizeCoins: "100" }],
    ["maxSpinsPerPlayerPerDay zero", { maxSpinsPerPlayerPerDay: 0 }],
    ["maxSpinsPerPlayerPerDay above 1000", { maxSpinsPerPlayerPerDay: 1001 }],
    ["maxPlayerRedeemShare zero", { maxPlayerRedeemShare: 0 }],
    ["maxPlayerRedeemShare above one", { maxPlayerRedeemShare: 1.01 }],
    ["minRedeemedForShare negative", { minRedeemedForShare: -1 }],
    ["a missing field", { maxSpinsPerPlayerPerDay: undefined }],
  ];

  test("the demo policy and the edges of every limit are accepted", () => {
    expect(validateOpsParams(ok)).toEqual(ok);
    for (const edge of [
      { pendingAgeLimitSec: 10 },
      { pendingAgeLimitSec: 86_400 },
      { maxSpinsPerPlayerPerDay: 1 },
      { maxSpinsPerPlayerPerDay: 1000 },
      { maxPlayerRedeemShare: 1 },
      { minRedeemedForShare: 0 },
      { maxExpectedPrizeCoins: 0.5 },
    ]) {
      expect(() => validateOpsParams({ ...ok, ...edge })).not.toThrow();
    }
  });

  test.each(bad)("rejects %s", (_name, change) => {
    expect(() => validateOpsParams({ ...ok, ...change })).toThrow();
  });

  test("rejects a value that is not an object", () => {
    expect(() => validateOpsParams(null)).toThrow();
    expect(() => validateOpsParams("x")).toThrow();
  });
});

describe.skipIf(!running)("ops policy in the database", () => {
  test("the newest version wins, both demo tenants start at version 1, and rows cannot be changed", async () => {
    for (const d of demoTenants) {
      const p = await loadOpsPolicy(app().db, d.id);
      expect(p?.version).toBeGreaterThanOrEqual(1);
    }
    const t = await newTenant();
    await setPolicy(t, 2, { pendingAgeLimitSec: 60 });
    expect((await loadOpsPolicy(app().db, t.id))?.params.pendingAgeLimitSec).toBe(60);
    await expect(
      app().db.query("UPDATE ops_policies SET params = '{}' WHERE tenant_id = $1", [t.id]),
    ).rejects.toThrow(/append-only/);
    await expect(app().db.query("DELETE FROM ops_policies WHERE tenant_id = $1", [t.id])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe.skipIf(!running)("the monitoring playbook", () => {
  test("every sql block in docs/monitoring-playbook.md runs against the schema", async () => {
    const text = readFileSync(new URL("../docs/monitoring-playbook.md", import.meta.url), "utf8");
    const blocks = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    // Give the queries something to look at: a tenant with spins, an issued redemption, a dead job.
    const t = await newTenant();
    await addSpins(t, "p-1", 3, { coins: 50 });
    await addIssued(t, "p-1", 100);
    for (const sql of blocks) {
      await expect(app().db.query(sql), sql).resolves.toBeDefined();
    }
  });
});
