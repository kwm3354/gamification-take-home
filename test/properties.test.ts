import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import { type FaultPoint, validFaults } from "../src/fake-casino/faults.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { type JudgedPlayer, collect, judge } from "./judge.ts";
import { signBeta, tokenFor } from "./signing.ts";

/**
 * Property test: whatever the faults and the order of player actions, once the faults stop and the
 * outbox has run, the judge finds no problems and every redemption is final and settled.
 *
 * A scenario is: players on both demo tenants (platform A has an idempotency key, B has none),
 * a list of steps (deposit, the same deposit again, spin, two spins at once, redeem, the same redeem
 * request again, two redeems at once, and "ticks" that move the app clock, run due jobs and
 * deliver platform B callbacks), and a fault plan for the fake casino (seeded chaos, or a script of
 * faults at named points). `slow_answer` is in the script plans with a short delay (160 ms against
 * a 100 ms platform time limit); chaos leaves it out because chaos uses a fixed 5 s delay.
 *
 * How to run and replay:
 *   npm test -- test/properties.test.ts                       fixed seed, FC_RUNS default
 *   FC_SEED=123 FC_RUNS=200 npx vitest run test/properties.test.ts   replay a printed seed
 *   npm run test:deep                                         random seed, many runs, longer time limit
 * A failure prints the seed, the run path and the shrunk scenario. The app clock and the fake's
 * chaos are seeded; the order of concurrent HTTP calls is not, so a replay is close, not exact.
 * FC_TIMEOUT_MS is the time limit of the whole property (default 90 s); fast-check stops starting
 * new runs 15 s before it, and the test says how many runs it did.
 */

const SEED = Number(process.env.FC_SEED ?? (process.env.FC_RANDOM ? Date.now() % 2 ** 31 : 20261121));
const RUNS = Number(process.env.FC_RUNS ?? 60);
const TIMEOUT_MS = Number(process.env.FC_TIMEOUT_MS ?? 90_000);

const seen = { runs: 0, faults: new Map<string, number>(), status: new Map<string, number>() };
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

const running = await startApp({ config: { platformTimeoutMs: 100 } });
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const tenantOf = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};
const ALPHA = "alpha-casino";
const BETA = "beta-casino";

beforeAll(async () => {
  if (running && fake) await seedDemo(running.db, running.clock, fake.url);
});
afterAll(async () => {
  await fake?.close();
  await running?.close();
});

// ---- the scenario -------------------------------------------------------------------------

type Act =
  | { t: "deposit" }
  | { t: "depositAgain" }
  | { t: "spin" }
  | { t: "spinTwice" }
  | { t: "redeem"; item: 0 | 1 }
  | { t: "redeemAgain" }
  | { t: "redeemTwice"; item: 0 | 1 };
type Step = { kind: "act"; player: number; act: Act } | { kind: "tick"; advanceMs: number; deliver: boolean };

interface ScriptedFault {
  point: FaultPoint;
  fault: string;
  times: number;
}
type FaultPlan = { kind: "chaos"; seed: number; rate: number } | { kind: "script"; faults: ScriptedFault[] };

interface Scenario {
  players: { tenant: string; coins: bigint }[];
  steps: Step[];
  plan: FaultPlan;
}

const points = Object.keys(validFaults) as FaultPoint[];
const scriptedFault: fc.Arbitrary<ScriptedFault> = fc.constantFrom(...points).chain((point) =>
  fc.record({
    point: fc.constant(point),
    fault: fc.constantFrom(...(validFaults[point] as string[])),
    times: fc.integer({ min: 1, max: 3 }),
  }),
);

const act: fc.Arbitrary<Act> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Act>({ t: "deposit" }) },
  { weight: 1, arbitrary: fc.constant<Act>({ t: "depositAgain" }) },
  { weight: 3, arbitrary: fc.constant<Act>({ t: "spin" }) },
  { weight: 1, arbitrary: fc.constant<Act>({ t: "spinTwice" }) },
  { weight: 4, arbitrary: fc.constantFrom<0 | 1>(0, 1).map((item): Act => ({ t: "redeem", item })) },
  { weight: 2, arbitrary: fc.constant<Act>({ t: "redeemAgain" }) },
  { weight: 2, arbitrary: fc.constantFrom<0 | 1>(0, 1).map((item): Act => ({ t: "redeemTwice", item })) },
);

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("act" as const), player: fc.nat(5), act }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("tick" as const),
      advanceMs: fc.constantFrom(0, 500, 1000, 2000, 5000),
      deliver: fc.boolean(),
    }),
  },
);

const scenario: fc.Arbitrary<Scenario> = fc.record({
  players: fc
    .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
    .chain(([a, b]) =>
      fc.tuple(
        fc.array(fc.constantFrom(0n, 300n, 1000n, 3000n, 3000n), { minLength: a, maxLength: a }),
        fc.array(fc.constantFrom(0n, 300n, 1000n, 3000n, 3000n), { minLength: b, maxLength: b }),
      ),
    )
    .map(([a, b]) => [
      ...a.map((coins) => ({ tenant: ALPHA, coins })),
      ...b.map((coins) => ({ tenant: BETA, coins })),
    ]),
  steps: fc.array(step, { minLength: 3, maxLength: 16 }),
  plan: fc.oneof(
    fc.record({
      kind: fc.constant("chaos" as const),
      seed: fc.integer({ min: 1, max: 1_000_000 }),
      rate: fc.constantFrom(0.1, 0.25, 0.4),
    }),
    fc.record({
      kind: fc.constant("script" as const),
      faults: fc.array(scriptedFault, { minLength: 1, maxLength: 6 }),
    }),
  ),
});

// ---- driving the app ----------------------------------------------------------------------

const app = () => {
  if (!running || !fake) throw new Error("no app");
  return running;
};
const fakeUrl = () => (fake as FakeCasino).url;
const post = (path: string, body: unknown) =>
  fetch(`${fakeUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function setFaults(plan: FaultPlan) {
  if (plan.kind === "script") {
    for (const f of plan.faults) {
      const r = await post("/control/faults", {
        ...f,
        ...(f.fault === "slow_answer" ? { delayMs: 160 } : {}),
      });
      expect(r.status).toBe(200);
    }
    return;
  }
  const rates: Record<string, Record<string, number>> = {};
  for (const point of points) {
    const kinds = (validFaults[point] as string[]).filter((k) => k !== "slow_answer");
    rates[point] = Object.fromEntries(kinds.map((k) => [k, plan.rate / kinds.length]));
  }
  expect((await post("/control/chaos", { seed: plan.seed, rates })).status).toBe(200);
}

interface Pl extends JudgedPlayer {
  playerUuid: string;
  /** Prize coins the player was shown, by spin id (a repeat of a spin shows the same prize). */
  prizes: Map<string, bigint>;
  lastDepositId: string | null;
  lastRedeem: { key: string; item: string } | null;
}

const bearer = (p: Pl) =>
  `Bearer ${tokenFor(p.tenantId, tenantOf(p.tenantId).tokenSecret, p.externalId, app().clock.now().getTime())}`;

async function deposit(p: Pl, eventId: string) {
  const r = await post("/control/deposit", {
    tenantId: p.tenantId,
    playerId: p.externalId,
    amount: "20.00",
    eventId,
  });
  expect(r.status).toBe(200);
}

async function spinsOf(p: Pl) {
  const r = await fetch(`${app().url}/me`, { headers: { authorization: bearer(p) } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { spins: { id: string; status: string }[] }).spins;
}

async function spinOnce(p: Pl, spinId: string) {
  const r = await fetch(`${app().url}/wheel/spins/${spinId}/spin`, {
    method: "POST",
    headers: { authorization: bearer(p) },
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { coins: string | number };
  const coins = BigInt(body.coins);
  const before = p.prizes.get(spinId);
  if (before !== undefined && before !== coins)
    throw new Error(`spin ${spinId} showed ${before} and then ${coins}`);
  p.prizes.set(spinId, coins);
}

async function redeemOnce(p: Pl, item: string, key: string) {
  const r = await fetch(`${app().url}/store/redemptions`, {
    method: "POST",
    headers: { authorization: bearer(p), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ itemId: item }),
  });
  expect([200, 201]).toContain(r.status);
}

async function runDue() {
  await app().app.get<Outbox>(OUTBOX).drain();
}
async function deliver() {
  await post("/control/b/deliver", {});
}

async function doAct(p: Pl, a: Act, items: [string, string]) {
  switch (a.t) {
    case "deposit": {
      p.lastDepositId = `ev-${randomUUID()}`;
      return deposit(p, p.lastDepositId);
    }
    case "depositAgain": {
      p.lastDepositId ??= `ev-${randomUUID()}`;
      await deposit(p, p.lastDepositId);
      return deposit(p, p.lastDepositId);
    }
    case "spin": {
      const open = (await spinsOf(p)).find((s) => s.status === "available");
      if (open) await spinOnce(p, open.id);
      return;
    }
    case "spinTwice": {
      const open = (await spinsOf(p)).find((s) => s.status === "available");
      if (open) await Promise.all([spinOnce(p, open.id), spinOnce(p, open.id)]);
      return;
    }
    case "redeem": {
      p.lastRedeem = { key: randomUUID(), item: items[a.item] };
      return redeemOnce(p, p.lastRedeem.item, p.lastRedeem.key);
    }
    case "redeemAgain": {
      const first = p.lastRedeem === null;
      p.lastRedeem ??= { key: randomUUID(), item: items[0] };
      if (first) await redeemOnce(p, p.lastRedeem.item, p.lastRedeem.key);
      return redeemOnce(p, p.lastRedeem.item, p.lastRedeem.key);
    }
    case "redeemTwice": {
      return void (await Promise.all([
        redeemOnce(p, items[a.item], randomUUID()),
        redeemOnce(p, items[a.item], randomUUID()),
      ]));
    }
  }
}

async function itemIds(tenantId: string): Promise<[string, string]> {
  const r = await app().db.query(
    "SELECT code, id FROM store_items WHERE tenant_id = $1 AND code IN ('bonus-1-eur', 'bonus-5-eur')",
    [tenantId],
  );
  const by = new Map(r.rows.map((x) => [x.code as string, x.id as string]));
  return [by.get("bonus-1-eur") as string, by.get("bonus-5-eur") as string];
}

/** What is still open, for the message when a run does not finish. */
async function stuckRows(ids: string[]) {
  const jobs = await app().db.query(
    `SELECT kind, ref_id, attempts, run_at, claimed_until, done_at, dead_at, last_error FROM outbox
     WHERE ref_id::text = ANY($1::text[]) AND done_at IS NULL`,
    [ids],
  );
  const reds = await app().db.query(
    "SELECT id, status, settled_at FROM redemptions WHERE id = ANY($1::uuid[]) AND (settled_at IS NULL OR status NOT IN ('issued','refused','insufficient'))",
    [ids],
  );
  return JSON.stringify({ openJobs: jobs.rows, openRedemptions: reds.rows }, null, 1);
}

async function runScenario(s: Scenario): Promise<void> {
  const a = app();
  // A clean start: the fake and its faults, jobs left by an earlier (failed) run, and the app clock back at real time
  // (platform A rejects events whose timestamp is more than 5 minutes from the app clock).
  await post("/control/reset", {});
  await a.db.query("UPDATE outbox SET done_at = now() WHERE done_at IS NULL");
  a.clock.advance(Date.now() - a.clock.now().getTime());
  const items = { [ALPHA]: await itemIds(ALPHA), [BETA]: await itemIds(BETA) };
  const ledger = a.app.get<CoinLedger>(COIN_LEDGER);

  const players: Pl[] = [];
  for (const [i, p] of s.players.entries()) {
    const externalId = `prop-${randomUUID()}-${i}`;
    const me = await fetch(`${a.url}/me`, {
      headers: {
        authorization: `Bearer ${tokenFor(p.tenant, tenantOf(p.tenant).tokenSecret, externalId, a.clock.now().getTime())}`,
      },
    });
    const playerUuid = ((await me.json()) as { playerId: string }).playerId;
    if (p.coins > 0n) {
      await ledger.creditPrize({
        ledgerNo: tenantOf(p.tenant).ledgerNo,
        playerId: playerUuid,
        spinId: randomUUID(),
        coins: p.coins,
      });
    }
    players.push({
      tenantId: p.tenant,
      externalId,
      creditedCoins: p.coins,
      playerUuid,
      prizes: new Map(),
      lastDepositId: null,
      lastRedeem: null,
    });
  }

  await setFaults(s.plan);
  for (const st of s.steps) {
    if (st.kind === "tick") {
      a.clock.advance(st.advanceMs);
      await runDue();
      if (st.deliver) await deliver();
    } else {
      const p = players[st.player % players.length] as Pl;
      await doAct(p, st.act, items[p.tenantId as typeof ALPHA]);
    }
  }

  // Faults off. Then time passes, jobs run and platform B delivers, until nothing is open.
  expect((await post("/control/faults/clear", {})).status).toBe(200);
  const mine = (
    await a.db.query("SELECT id FROM redemptions WHERE player_id = ANY($1::uuid[])", [
      players.map((p) => p.playerUuid),
    ])
  ).rows.map((r) => r.id as string);
  const openCount = async () =>
    Number(
      (
        await a.db.query(
          "SELECT count(*) FROM outbox WHERE done_at IS NULL AND dead_at IS NULL AND tenant_id = ANY($1)",
          [[ALPHA, BETA]],
        )
      ).rows[0].count,
    );
  let rounds = 0;
  for (; rounds < 30; rounds++) {
    a.clock.advance(65_000);
    await runDue();
    await deliver();
    await runDue();
    if ((await openCount()) === 0) break;
  }
  if ((await openCount()) !== 0) {
    throw new Error(`jobs still open after ${rounds} rounds of 65 s: ${await stuckRows(mine)}`);
  }

  // Every redemption is final and settled; no job died.
  const stuck = await a.db.query(
    "SELECT id, status, settled_at FROM redemptions WHERE player_id = ANY($1::uuid[]) AND (settled_at IS NULL OR status NOT IN ('issued','refused','insufficient'))",
    [players.map((p) => p.playerUuid)],
  );
  if (stuck.rowCount) throw new Error(`redemptions not final: ${JSON.stringify(stuck.rows)}`);
  const dead = await a.db.query(
    "SELECT kind, ref_id, last_error FROM outbox WHERE dead_at IS NOT NULL AND ref_id::text = ANY($1::text[])",
    [mine],
  );
  if (dead.rowCount) throw new Error(`dead jobs: ${JSON.stringify(dead.rows)}`);

  // A late notice from platform B that contradicts the final state must change nothing.
  const late = await a.db.query(
    `SELECT r.id, r.status, r.platform_ref FROM redemptions r JOIN tenants t ON t.id = r.tenant_id
     WHERE t.platform = 'B' AND r.status IN ('issued', 'refused') AND r.player_id = ANY($1::uuid[])`,
    [players.map((p) => p.playerUuid)],
  );
  for (const r of late.rows) {
    const body = JSON.stringify({
      requestId: r.platform_ref ?? "late",
      externalRef: r.id,
      state: r.status === "issued" ? "DECLINED" : "GRANTED",
      ...(r.status === "issued" ? { reason: "late" } : {}),
    });
    const res = await fetch(`${a.url}/webhooks/${BETA}/rewards`, {
      method: "POST",
      headers: signBeta(tenantOf(BETA).webhookSecret, body),
      body,
    });
    expect(res.status).toBeLessThan(500);
  }
  await runDue();
  const after = await a.db.query("SELECT id, status FROM redemptions WHERE id = ANY($1::uuid[])", [
    late.rows.map((r) => r.id),
  ]);
  const wasStatus = new Map(late.rows.map((r) => [r.id as string, r.status as string]));
  for (const r of after.rows) {
    if (wasStatus.get(r.id) !== r.status)
      throw new Error(`late notice changed ${r.id}: ${wasStatus.get(r.id)} -> ${r.status}`);
  }

  // Coins the player was shown for spins are the coins credited; add them to what the test gave.
  for (const p of players) for (const coins of p.prizes.values()) p.creditedCoins += coins;
  const state = (await (await fetch(`${fakeUrl()}/control/state`)).json()) as {
    requests: { point: string; fault: string | null }[];
    callbacks: { status: string; sentCount: number }[];
  };
  for (const r of state.requests) if (r.fault) bump(seen.faults, `${r.point}:${r.fault}`);
  for (const c of state.callbacks) {
    if (c.status === "lost") bump(seen.faults, "b.callback:lost");
    if (c.sentCount > 1) bump(seen.faults, "b.callback:twice");
  }
  const finals = await a.db.query(
    "SELECT status, count(*) FROM redemptions WHERE id = ANY($1::uuid[]) GROUP BY status",
    [mine],
  );
  for (const r of finals.rows) seen.status.set(r.status, (seen.status.get(r.status) ?? 0) + Number(r.count));
  seen.runs++;
  const problems = judge(await collect(a, { url: fakeUrl() }, players));
  if (problems.length) throw new Error(`judge: ${problems.join("; ")}`);
}

describe.skipIf(!running)("property: faults and player actions", () => {
  test(
    `the judge finds nothing and every redemption ends final (seed ${SEED}, up to ${RUNS} runs)`,
    async () => {
      let done = 0;
      const property = fc.asyncProperty(scenario, async (s) => {
        await runScenario(s);
        done++;
      });
      try {
        await fc.assert(property, {
          seed: SEED,
          numRuns: RUNS,
          interruptAfterTimeLimit: Math.max(TIMEOUT_MS - 15_000, 10_000),
        });
      } catch (e) {
        throw new Error(
          `property failed. Replay: FC_SEED=${SEED} FC_RUNS=${RUNS} npx vitest run test/properties.test.ts\n${e instanceof Error ? e.message : String(e)}`,
        );
      }
      console.log(
        `properties: seed ${SEED}, ${done} runs passed. Faults applied: ${JSON.stringify(Object.fromEntries(seen.faults))}. Redemptions by final status: ${JSON.stringify(Object.fromEntries(seen.status))}`,
      );
      expect(done).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
