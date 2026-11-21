import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PLATFORMS, type Platforms } from "../src/domain/casino-platform.ts";
import { COIN_LEDGER, type CoinLedger, LedgerUnavailable } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import type { FakeState } from "../src/fake-casino/state.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { StoreService } from "../src/store/store.service.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { type JudgeInput, type JudgedPlayer, collect, judge } from "./judge.ts";
import { signBeta, tokenFor } from "./signing.ts";

// Whole app, real HTTP, real PostgreSQL, real TigerBeetle, the fake casino as the platform.
// Skipped when no TigerBeetle is available.
const running = await startApp();
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const ALPHA = "alpha-casino";
const BETA = "beta-casino";
type TenantId = typeof ALPHA | typeof BETA;
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
const store = () => app().app.get(StoreService);
const now = () => app().clock.now().getTime();

interface P extends JudgedPlayer {
  id: string; // our uuid
}

const tokenOf = (p: { tenantId: string; externalId: string }) =>
  tokenFor(p.tenantId, tenantOf(p.tenantId).tokenSecret, p.externalId, now());

/** A new player with `coins` in the ledger. The first call to /me creates the player. */
async function newPlayer(tenantId: TenantId, coins: bigint): Promise<P> {
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
  costCoins: string;
  reward: unknown;
  reason: string | null;
  platformRef: string | null;
  settled: boolean;
}

async function redeem(p: JudgedPlayer, item: string, key: string | null = randomUUID()) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tokenOf(p)}`,
    "content-type": "application/json",
  };
  if (key !== null) headers["idempotency-key"] = key;
  const r = await fetch(`${app().url}/store/redemptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ itemId: item }),
  });
  return { status: r.status, json: (await r.json()) as View };
}

async function getRedemption(p: JudgedPlayer, id: string) {
  const r = await fetch(`${app().url}/store/redemptions/${id}`, {
    headers: { authorization: `Bearer ${tokenOf(p)}` },
  });
  return { status: r.status, json: (await r.json()) as View };
}

async function fakeState(): Promise<FakeState> {
  return (await (await fetch(`${fakeUrl()}/control/state`)).json()) as FakeState;
}
const grantsFor = async (reference: string) =>
  (await fakeState()).grants.filter((g) => g.reference === reference);

async function fault(point: string, kind: string, times = 1, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${fakeUrl()}/control/faults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ point, fault: kind, times, ...extra }),
  });
  expect(r.status).toBe(200);
}

async function deliver(): Promise<number> {
  const r = await fetch(`${fakeUrl()}/control/b/deliver`, { method: "POST" });
  return ((await r.json()) as { delivered: unknown[] }).delivered.length;
}

/** Moves the clock and runs the jobs that are due. */
async function later(ms: number) {
  app().clock.advance(ms);
  return outbox().runDue();
}

async function verdict(...players: P[]) {
  return judge(await collect(app(), { url: fakeUrl() }, players));
}

async function final(p: P, id: string) {
  const v = (await getRedemption(p, id)).json;
  const b = await ledger().balance({ ledgerNo: tenantOf(p.tenantId).ledgerNo, playerId: p.id });
  return {
    status: v.status,
    settled: v.settled,
    available: b.available,
    reserved: b.reserved,
    grants: (await grantsFor(id)).length,
  };
}

const balanceOf = (p: P) => ledger().balance({ ledgerNo: tenantOf(p.tenantId).ledgerNo, playerId: p.id });
const requestsFor = async (reference: string, point: string) =>
  (await fakeState()).requests.filter((r) => r.reference === reference && r.point === point);

/** Final states of the runs with faults, compared with a clean run in the last test. */
const finals = new Map<string, Awaited<ReturnType<typeof final>>>();

beforeEach(async () => {
  if (!running || !fake) return;
  await fetch(`${fakeUrl()}/control/reset`, { method: "POST" });
  // Jobs left over from an earlier test must not run against the reset fake.
  await running.db.query("UPDATE outbox SET done_at = now() WHERE done_at IS NULL");
  running.config.inlineJobs = true;
});

describe.skipIf(!running)("bonus store", () => {
  test("1. platform A happy path: issued and settled at once, charged once, one grant with our reference", async () => {
    const p = await newPlayer(ALPHA, 500n);
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "issued", costCoins: "100", settled: true, reason: null });
    expect(r.json.reward).toEqual({ type: "bonus", amountMinor: 100, currency: "EUR" });
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
    const grants = await grantsFor(r.json.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ tenantId: ALPHA, playerId: p.externalId, amountMinor: 100 });
    expect(r.json.platformRef).toBe(grants[0]?.platformRef);
    expect(await verdict(p)).toEqual([]);
    finals.set("clean-A", await final(p, r.json.id));
  });

  test("2. platform B happy path: submitting with coins reserved, then the callback issues it", async () => {
    const p = await newPlayer(BETA, 500n);
    const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("submitting");
    expect((await getRedemption(p, r.json.id)).json.status).toBe("submitting");
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 100n });
    expect(await verdict(p)).toEqual([]); // not settled yet: only the no-duplicate rules apply
    expect(await deliver()).toBe(1);
    const after = (await getRedemption(p, r.json.id)).json;
    expect(after).toMatchObject({ status: "issued", settled: true });
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
    finals.set("clean-B", await final(p, r.json.id));
  });

  test("3. the same Idempotency-Key twice: 201 then 200, one redemption, charged once; a new key is a new redemption", async () => {
    const p = await newPlayer(ALPHA, 500n);
    const item = await itemId(ALPHA, "bonus-1-eur");
    const key = randomUUID();
    const first = await redeem(p, item, key);
    const second = await redeem(p, await itemId(ALPHA, "bonus-5-eur"), key); // a different item in the body is ignored
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.costCoins).toBe("100");
    expect(await grantsFor(first.json.id)).toHaveLength(1);
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
    const other = await redeem(p, item, randomUUID());
    expect(other.status).toBe(201);
    expect(other.json.id).not.toBe(first.json.id);
    expect(await balanceOf(p)).toEqual({ available: 300n, reserved: 0n });
    expect(await verdict(p)).toEqual([]);
  });

  test("4. ten identical requests at once: one redemption id in every answer, one grant, charged once", async () => {
    const p = await newPlayer(ALPHA, 500n);
    const item = await itemId(ALPHA, "bonus-1-eur");
    const key = randomUUID();
    const answers = await Promise.all(Array.from({ length: 10 }, () => redeem(p, item, key)));
    expect(new Set(answers.map((a) => a.json.id)).size).toBe(1);
    expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(9);
    const id = (answers[0] as (typeof answers)[number]).json.id;
    expect(await grantsFor(id)).toHaveLength(1);
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
    expect((await getRedemption(p, id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await verdict(p)).toEqual([]);
  });

  test("5. not enough coins: insufficient, nothing reserved, the platform is never called", async () => {
    const p = await newPlayer(ALPHA, 50n);
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("insufficient");
    expect(await balanceOf(p)).toEqual({ available: 50n, reserved: 0n });
    expect((await fakeState()).requests.filter((q) => q.reference === r.json.id)).toHaveLength(0);
    expect(await verdict(p)).toEqual([]);
  });

  test("6. eight requests at once for a balance that pays five: five issued, three insufficient, never below zero", async () => {
    const p = await newPlayer(ALPHA, 500n);
    const item = await itemId(ALPHA, "bonus-1-eur");
    const answers = await Promise.all(Array.from({ length: 8 }, () => redeem(p, item)));
    const states = await Promise.all(answers.map((a) => getRedemption(p, a.json.id)));
    const count = (s: string) => states.filter((x) => x.json.status === s).length;
    expect(count("issued")).toBe(5);
    expect(count("insufficient")).toBe(3);
    expect(await balanceOf(p)).toEqual({ available: 0n, reserved: 0n });
    expect((await fakeState()).grants.filter((g) => g.playerId === p.externalId)).toHaveLength(5);
    expect(await verdict(p)).toEqual([]);
  });

  test("7a. platform A refuses: refused with the reason, coins back in full, settled", async () => {
    const p = await newPlayer(ALPHA, 500n);
    await fault("a.grant", "refuse");
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    expect(r.json).toMatchObject({ status: "refused", reason: "player_blocked", settled: true });
    expect(await balanceOf(p)).toEqual({ available: 500n, reserved: 0n });
    expect(await grantsFor(r.json.id)).toHaveLength(0);
    expect(await verdict(p)).toEqual([]);
  });

  test("7b. platform B declines by callback: refused, coins back in full, settled", async () => {
    const p = await newPlayer(BETA, 500n);
    await fault("b.grant", "refuse");
    const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
    expect(r.json.status).toBe("submitting");
    expect(await deliver()).toBe(1);
    const after = (await getRedemption(p, r.json.id)).json;
    expect(after).toMatchObject({ status: "refused", reason: "player_blocked", settled: true });
    expect(await balanceOf(p)).toEqual({ available: 500n, reserved: 0n });
    expect(await verdict(p)).toEqual([]);
  });

  test("8. A, lost answer: the grant exists, we are told nothing; the look finds it; still one grant", async () => {
    const p = await newPlayer(ALPHA, 500n);
    await fault("a.grant", "lost_answer");
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    expect(r.json.status).toBe("submitting");
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 100n });
    expect(await outbox().runDue()).toBe(0); // the wait has not passed
    expect(await later(1000)).toBeGreaterThan(0);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await requestsFor(r.json.id, "a.grant")).toHaveLength(1); // found, not issued again
    expect(await verdict(p)).toEqual([]);
    finals.set("lost-answer-A", await final(p, r.json.id));
  });

  test("9. A, lost request: no grant yet; the look finds nothing; then it is issued; one grant", async () => {
    const p = await newPlayer(ALPHA, 500n);
    await fault("a.grant", "lost_request");
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    expect(r.json.status).toBe("submitting");
    expect(await grantsFor(r.json.id)).toHaveLength(0);
    await later(1000);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
    finals.set("lost-request-A", await final(p, r.json.id));
  });

  test("10. A, answer slower than the time limit: the request returns in time, recovery gives one grant", async () => {
    const p = await newPlayer(ALPHA, 500n);
    await fault("a.grant", "slow_answer", 1, { delayMs: 1000 });
    const started = performance.now();
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    const took = performance.now() - started;
    expect(r.json.status).toBe("submitting");
    expect(took).toBeLessThan(900); // limit 300 ms: the call was cancelled, not waited for
    await later(1000);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
  });

  test("11. B, lost answer (B has no idempotency): recovery looks first, so only one request exists", async () => {
    const p = await newPlayer(BETA, 500n);
    await fault("b.grant", "lost_answer");
    const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
    expect(r.json.status).toBe("submitting");
    expect(await requestsFor(r.json.id, "b.grant")).toHaveLength(1); // B accepted, we never heard
    await later(1000);
    expect(await requestsFor(r.json.id, "b.grant")).toHaveLength(1); // still one: the look found it
    expect((await getRedemption(p, r.json.id)).json.status).toBe("submitting");
    expect(await deliver()).toBe(1);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
    finals.set("lost-answer-B", await final(p, r.json.id));
  });

  test("12. B, callback lost: stays submitting until the next look sees GRANTED", async () => {
    const p = await newPlayer(BETA, 500n);
    await fault("b.callback", "lost");
    const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
    await deliver();
    expect((await getRedemption(p, r.json.id)).json.status).toBe("submitting");
    expect(await grantsFor(r.json.id)).toHaveLength(1); // B did grant
    await later(2000);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
    finals.set("callback-lost-B", await final(p, r.json.id));
  });

  test("13. B, callback twice: the second changes nothing, one capture", async () => {
    const p = await newPlayer(BETA, 500n);
    await fault("b.callback", "twice");
    const r = await redeem(p, await itemId(BETA, "bonus-1-eur"));
    await deliver();
    const state = await fakeState();
    expect(state.callbacks.find((c) => c.externalRef === r.json.id)?.sentCount).toBe(2);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
    // A late notice that contradicts the final state changes nothing either.
    const late = JSON.stringify({
      requestId: "r_late",
      externalRef: r.json.id,
      state: "DECLINED",
      reason: "late",
    });
    const answer = await fetch(`${app().url}/webhooks/${BETA}/rewards`, {
      method: "POST",
      headers: signBeta(tenantOf(BETA).webhookSecret, late),
      body: late,
    });
    expect(await answer.json()).toEqual({ redemptionId: r.json.id, status: "issued" });
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({
      status: "issued",
      reason: null,
      settled: true,
    });
    expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
    expect(await verdict(p)).toEqual([]);
  });

  test("14a. A, three 500s and one 429 at grant: stays submitting, honours Retry-After, ends issued with one grant", async () => {
    const p = await newPlayer(ALPHA, 500n);
    await fault("a.grant", "error_500", 3);
    await fault("a.grant", "rate_limit", 1);
    const dueIn = async (id: string) => {
      const r = await app().db.query("SELECT run_at FROM outbox WHERE ref_id = $1", [id]);
      return new Date(r.rows[0].run_at).getTime() - now();
    };
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    const id = r.json.id;
    expect(r.json.status).toBe("submitting");
    expect(await dueIn(id)).toBe(1000); // first backoff
    await later(1000);
    expect((await getRedemption(p, id)).json.status).toBe("submitting");
    expect(await dueIn(id)).toBe(2000); // backoff grows
    await later(2000);
    expect((await getRedemption(p, id)).json.status).toBe("submitting");
    expect(await dueIn(id)).toBe(4000);
    await later(4000); // the 429 with Retry-After: 1
    expect((await getRedemption(p, id)).json.status).toBe("submitting");
    expect(await dueIn(id)).toBe(1000); // the platform's word, not our backoff
    expect(await grantsFor(id)).toHaveLength(0);
    await later(1000);
    expect((await getRedemption(p, id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
    finals.set("errors-A", await final(p, id));
  });

  test("14b. A, the look fails: no blind re-issue while we cannot look", async () => {
    const p = await newPlayer(ALPHA, 500n);
    await fault("a.find", "error_500", 2);
    const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
    const id = r.json.id;
    expect(r.json.status).toBe("submitting");
    await later(1000);
    expect((await getRedemption(p, id)).json.status).toBe("submitting");
    expect(await requestsFor(id, "a.grant")).toHaveLength(0); // never issued without looking
    await later(2000);
    expect((await getRedemption(p, id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await requestsFor(id, "a.grant")).toHaveLength(1);
    expect(await grantsFor(id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
  });

  describe("15. crash points: the step ran, the process died, the job runs again", () => {
    for (const [name, tenantId] of [
      ["A", ALPHA],
      ["B", BETA],
    ] as const) {
      test(`platform ${name}: repeated side effects at every state give the clean result`, async () => {
        app().config.inlineJobs = false;
        const t = tenantOf(tenantId);
        const p = await newPlayer(tenantId, 500n);
        const r = await redeem(p, await itemId(tenantId, "bonus-1-eur"));
        const id = r.json.id;
        expect(r.json.status).toBe("created");
        const status = async () => (await getRedemption(p, id)).json.status;
        const platform = app().app.get<Platforms>(PLATFORMS).for(t.platform);
        const conn = {
          tenantId,
          platformUrl: fakeUrl(),
          platformKey: t.platformKey,
          webhookSecret: t.webhookSecret,
        };
        const reward = { type: "bonus" as const, amountMinor: 100, currency: "EUR" };

        // Died after the ledger reserve, before the status write: the reserve is repeated.
        await ledger().reserve({ ledgerNo: t.ledgerNo, playerId: p.id, redemptionId: id, coins: 100n });
        expect(await store().advance(id)).toBe("again");
        expect(await status()).toBe("reserved");
        expect(await store().advance(id)).toBe("again");
        expect(await status()).toBe("submitting");
        expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 100n });

        // Died right after the platform accepted the grant, before we wrote anything.
        await platform.issueReward(conn, { redemptionId: id, externalPlayerId: p.externalId, reward });
        const stepped = await store().advance(id);
        if (name === "A") {
          expect(stepped).toBe("again");
          expect(await status()).toBe("issued");
        } else {
          expect(stepped).toEqual({ retryInMs: 2000 }); // accepted, not final: found, not issued again
          expect(await status()).toBe("submitting");
          expect(await deliver()).toBe(1);
          expect(await status()).toBe("issued"); // the webhook confirmed it (no inline run, so not settled yet)
        }

        // Died after the capture, before settled_at: the capture is repeated.
        await ledger().capture({ ledgerNo: t.ledgerNo, redemptionId: id });
        expect(await store().advance(id)).toBe("done");
        expect(await store().advance(id)).toBe("done");
        expect(await getRedemption(p, id)).toMatchObject({ json: { status: "issued", settled: true } });
        expect(await grantsFor(id)).toHaveLength(1);
        expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
        expect(await verdict(p)).toEqual([]);
      });
    }
  });

  test("16. ledger away while settling: shows issued but not settled; settles on the next run; charged once", async () => {
    const p = await newPlayer(ALPHA, 500n);
    const coins = ledger();
    const real = coins.capture.bind(coins);
    let failures = 1;
    coins.capture = async (input) => {
      if (failures-- > 0) throw new LedgerUnavailable("ledger away (test)");
      return real(input);
    };
    try {
      const r = await redeem(p, await itemId(ALPHA, "bonus-1-eur"));
      expect(r.json).toMatchObject({ status: "issued", settled: false });
      expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 100n });
      await later(1000);
      expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
      expect(await balanceOf(p)).toEqual({ available: 400n, reserved: 0n });
      expect(await grantsFor(r.json.id)).toHaveLength(1);
      expect(await verdict(p)).toEqual([]);
    } finally {
      coins.capture = real;
    }
  });

  test("17. reward webhook: bad signature, other tenant, platform A, and a notice too early", async () => {
    const beta = tenantOf(BETA);
    const notice = (ref: string, state = "GRANTED") =>
      JSON.stringify({ requestId: "r_x", externalRef: ref, state, reason: "x" });
    const post = (path: string, body: string, headers: Record<string, string>) =>
      fetch(`${app().url}/webhooks/${path}/rewards`, { method: "POST", headers, body });
    const rejected = async () =>
      Number(
        (await app().db.query("SELECT count(*) AS n FROM audit_log WHERE action = 'webhook_rejected'"))
          .rows[0].n,
      );

    // A bad signature is 401 and leaves an audit row.
    const before = await rejected();
    const forged = await post(BETA, notice(randomUUID()), signBeta("wrong-secret", notice(randomUUID())));
    expect(forged.status).toBe(401);
    expect(await rejected()).toBe(before + 1);

    // Platform A never sends reward notices.
    const a = notice(randomUUID());
    expect((await post(ALPHA, a, signBeta(beta.webhookSecret, a))).status).toBe(400);

    // A valid beta notice for a redemption of alpha, sent to beta's path: 404, nothing changes.
    app().config.inlineJobs = false;
    const pa = await newPlayer(ALPHA, 500n);
    const ra = await redeem(pa, await itemId(ALPHA, "bonus-1-eur"));
    await store().advance(ra.json.id); // reserved
    await store().advance(ra.json.id); // submitting
    expect((await getRedemption(pa, ra.json.id)).json.status).toBe("submitting");
    const foreign = notice(ra.json.id);
    expect((await post(BETA, foreign, signBeta(beta.webhookSecret, foreign))).status).toBe(404);
    expect((await getRedemption(pa, ra.json.id)).json.status).toBe("submitting");

    // A notice for a redemption we have not sent to the platform yet cannot be real: ignored and recorded.
    const pb = await newPlayer(BETA, 500n);
    const rb = await redeem(pb, await itemId(BETA, "bonus-1-eur"));
    await store().advance(rb.json.id); // reserved
    const early = notice(rb.json.id);
    const answer = await post(BETA, early, signBeta(beta.webhookSecret, early));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ redemptionId: rb.json.id, status: "reserved" });
    expect((await getRedemption(pb, rb.json.id)).json.status).toBe("reserved");
    const ignored = await app().db.query(
      "SELECT 1 FROM audit_log WHERE action = 'reward_notice_ignored' AND entity_id = $1",
      [rb.json.id],
    );
    expect(ignored.rowCount).toBe(1);
  });

  test("18. tenant isolation on the player API", async () => {
    const pa = await newPlayer(ALPHA, 500n);
    const pb = await newPlayer(BETA, 500n);
    const ra = await redeem(pa, await itemId(ALPHA, "bonus-1-eur"));
    expect((await getRedemption(pb, ra.json.id)).status).toBe(404);
    expect((await redeem(pb, await itemId(ALPHA, "bonus-1-eur"))).status).toBe(404);
    const items = await fetch(`${app().url}/store/items`, {
      headers: { authorization: `Bearer ${tokenOf(pb)}` },
    });
    const list = (await items.json()) as { id: string; code: string; costCoins: string }[];
    const own = await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1", [BETA]);
    expect(list.map((i) => i.id).sort()).toEqual(own.rows.map((r) => r.id).sort());
    expect(list.map((i) => i.code).sort()).toEqual(["bonus-1-eur", "bonus-5-eur"]);
    expect(list.find((i) => i.code === "bonus-1-eur")?.costCoins).toBe("100");
    expect(await balanceOf(pb)).toEqual({ available: 500n, reserved: 0n });
    expect(await verdict(pa, pb)).toEqual([]);
  });

  test("19. a missing Idempotency-Key is 400, a missing token is 401", async () => {
    const p = await newPlayer(ALPHA, 500n);
    const item = await itemId(ALPHA, "bonus-1-eur");
    expect((await redeem(p, item, null)).status).toBe(400);
    expect((await redeem(p, item, "")).status).toBe(400);
    expect((await redeem(p, item, "k".repeat(201))).status).toBe(400);
    const noToken = await fetch(`${app().url}/store/redemptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ itemId: item }),
    });
    expect(noToken.status).toBe(401);
    expect((await fetch(`${app().url}/store/items`)).status).toBe(401);
    expect((await redeem(p, randomUUID())).status).toBe(404);
    const rows = await app().db.query("SELECT count(*) AS n FROM redemptions WHERE player_id = $1", [p.id]);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test("21. the timer and the request never run one redemption at the same time (B has no idempotency)", async () => {
    const p = await newPlayer(BETA, 500n);
    await fault("b.grant", "slow_answer", 1, { delayMs: 50 }); // makes the issue call visible in the log
    await fault("b.find", "slow_answer", 1, { delayMs: 150 }); // the request's look takes a while
    const posted = redeem(p, await itemId(BETA, "bonus-1-eur"));
    // Wait for the request's look to reach the casino, then let the timer's runner try the same job.
    for (let i = 0; i < 200 && (await fakeState()).requests.every((q) => q.point !== "b.find"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await fakeState()).requests.some((q) => q.point === "b.find")).toBe(true);
    expect(await outbox().runDue()).toBe(0); // the job is locked by the request
    const r = await posted;
    expect(r.json.status).toBe("submitting");
    expect(await requestsFor(r.json.id, "b.grant")).toHaveLength(1);
    expect(await deliver()).toBe(1);
    expect((await getRedemption(p, r.json.id)).json).toMatchObject({ status: "issued", settled: true });
    expect(await grantsFor(r.json.id)).toHaveLength(1);
    expect(await verdict(p)).toEqual([]);
  });

  test("20. differential: every run with faults ends where the clean run of the same input ends", async () => {
    const cleanA = finals.get("clean-A");
    const cleanB = finals.get("clean-B");
    expect(cleanA, "run the whole file: test 1 gives the clean run of A").toBeDefined();
    expect(cleanB, "run the whole file: test 2 gives the clean run of B").toBeDefined();
    for (const name of ["lost-answer-A", "lost-request-A", "errors-A"]) {
      expect(finals.get(name), name).toEqual(cleanA);
    }
    for (const name of ["lost-answer-B", "callback-lost-B"]) {
      expect(finals.get(name), name).toEqual(cleanB);
    }
    expect(cleanA).toEqual({ status: "issued", settled: true, available: 400n, reserved: 0n, grants: 1 });
  });
});

describe("the judge can say no", () => {
  const redemption = {
    id: "r1",
    tenantId: "alpha-casino",
    externalPlayerId: "p1",
    status: "issued",
    settled: true,
    costCoins: 100n,
  };
  const grant = (reference: string, n = 1) => ({
    tenantId: "alpha-casino",
    platform: "A" as const,
    playerId: "p1",
    reference,
    amountMinor: 100,
    currency: "EUR",
    platformRef: `b_${n}`,
    at: "2026-01-01T00:00:00Z",
  });
  const balance = {
    tenantId: "alpha-casino",
    externalPlayerId: "p1",
    creditedCoins: 500n,
    available: 400n,
    reserved: 0n,
  };
  const clean: JudgeInput = {
    fakeState: { grants: [grant("r1")] },
    redemptions: [redemption],
    balances: [balance],
  };

  test("a clean world has no complaints", () => {
    expect(judge(clean)).toEqual([]);
  });

  test("a double grant is a violation", () => {
    const input = { ...clean, fakeState: { grants: [grant("r1", 1), grant("r1", 2)] } };
    expect(judge(input).join("\n")).toContain("granted 2 times");
  });

  test("an issued redemption without a grant is a violation", () => {
    const input = { ...clean, fakeState: { grants: [] } };
    expect(judge(input).join("\n")).toContain("no grant");
  });

  test("a negative balance is a violation", () => {
    const input = { ...clean, balances: [{ ...balance, available: -1n }] };
    expect(judge(input).join("\n")).toContain("negative balance");
  });

  test("coins taken for a refused redemption, and coins still held when settled, are violations", () => {
    const refused = { ...redemption, status: "refused" };
    const input: JudgeInput = {
      fakeState: { grants: [] },
      redemptions: [refused],
      balances: [{ ...balance, available: 400n, reserved: 100n }],
    };
    const said = judge(input).join("\n");
    expect(said).toContain("expected 500 credited minus 0 spent");
    expect(said).toContain("still reserved");
  });

  test("a grant for a refused redemption, and one to the wrong player, are violations", () => {
    const refused = { ...redemption, status: "refused" };
    const wrong = { ...grant("r1"), playerId: "someone-else" };
    const said = judge({ fakeState: { grants: [wrong] }, redemptions: [refused], balances: [] }).join("\n");
    expect(said).toContain("granted a reward");
    expect(said).toContain("went to");
  });
});
