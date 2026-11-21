import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient } from "tigerbeetle-node";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { systemClock } from "../src/clock.ts";
import type { Db } from "../src/db.ts";
import { connect } from "../src/db.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { TigerBeetleCoinLedger } from "../src/ledger/coin-ledger.tigerbeetle.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { TEST_ADMIN_TOKEN_SECRET } from "./app.ts";
import { startFake } from "./fake.ts";
import { freshDb } from "./harness.ts";
import { type JudgedPlayer, collect, judge } from "./judge.ts";
import { tokenFor } from "./signing.ts";
import { startTigerBeetle } from "./tigerbeetle.ts";

/**
 * The one slow suite: real operating system processes (the API and workers, the same entry the
 * Docker image runs: `node dist/main.js`), a real clock, and SIGKILL.
 *
 * Why compiled JavaScript and not `tsx src/main.ts`: NestJS finds what to inject from decorator
 * metadata, which tsx (esbuild) does not emit. The image runs the output of `tsc`, so this test
 * builds it once into node_modules/.cache/processes-dist (a few seconds) and starts that.
 *
 * Outside world: the fake casino runs inside this test process (it is the outside world). PostgreSQL
 * and TigerBeetle are the ones global-setup started. Each child has a short lease (3 s) and a short
 * poll, set through OUTBOX_LEASE_MS and OUTBOX_POLL_MS.
 *
 *  A. A worker is killed while it holds claimed jobs; two new workers finish them.
 *  B. The API is killed after the request committed and before any job ran; workers alone finish
 *     what needs no callback, a restarted API receives the platform B callbacks.
 *  D. A handler outlives its lease (1 s): the second worker takes over and the first one is fenced out.
 *  C. Three workers, no kills: every redemption is issued once and every job is done.
 *
 * The worker that is killed in A is the only worker while it claims, so the claims seen at the
 * kill are its claims for certain (the outbox does not record who holds a claim).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "node_modules", ".cache", "processes-dist");
const ALPHA = "alpha-casino";
const BETA = "beta-casino";
const LEASE_MS = 3000;
const tenantOf = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};

// ---- children --------------------------------------------------------------------------

interface Child {
  name: string;
  proc: ChildProcess;
  lines: string[];
  exited: boolean;
  /** True when the test killed it on purpose. */
  expected: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
}
const children: Child[] = [];
const tail = (c: Child) => c.lines.slice(-40).join("\n");

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const a = probe.address();
      probe.close(() => (a && typeof a === "object" ? ok(a.port) : fail(new Error("no port"))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns true. Fails with the tail of any child that died on its own. */
async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs: number, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = children.find((c) => c.exited && !c.expected);
    if (dead) {
      throw new Error(
        `${dead.name} died on its own (${JSON.stringify(dead.exit)}) while waiting for ${what}. Last output:\n${tail(dead)}`,
      );
    }
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ---- the world ------------------------------------------------------------------------

let tbAddress = "";
let stopTb: (() => void) | undefined;
let db: Db;
let dbUrl = "";
let fake: FakeCasino;
let ledgerClient: Client;
let coins: TigerBeetleCoinLedger;
let apiPort = 0;
let ready = false;

const apiUrl = () => `http://127.0.0.1:${apiPort}`;

function start(name: string, role: "api" | "worker", extra: Record<string, string> = {}): Child {
  const port = role === "api" ? apiPort : 0;
  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    DATABASE_URL: dbUrl,
    TB_ADDRESS: tbAddress,
    ADMIN_TOKEN_SECRET: TEST_ADMIN_TOKEN_SECRET,
    ROLE: role,
    PORT: String(port),
    OUTBOX_POLL_MS: "50",
    OUTBOX_LEASE_MS: String(LEASE_MS),
    OUTBOX_BATCH: "4",
    PLATFORM_TIMEOUT_MS: "1000",
    LEDGER_TIMEOUT_MS: "2000",
    DB_POOL_MAX: "6",
    ...extra,
  };
  const proc = spawn(process.execPath, [join(distDir, "main.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child: Child = { name, proc, lines: [], exited: false, expected: false, exit: null };
  const keep = (chunk: Buffer) => {
    for (const l of chunk.toString().split("\n")) if (l) child.lines.push(l);
    if (child.lines.length > 4000) child.lines.splice(0, 2000);
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  proc.once("exit", (code, signal) => {
    child.exited = true;
    child.exit = { code, signal };
  });
  children.push(child);
  return child;
}

/** A worker listens on a random port; the test reads it from nothing: it checks the database instead. */
async function startApi(name: string, extra: Record<string, string> = {}): Promise<Child> {
  const c = start(name, "api", extra);
  await waitFor(
    `${name} to answer /health`,
    async () => {
      try {
        return (await fetch(`${apiUrl()}/health`)).status === 200;
      } catch {
        return false;
      }
    },
    30_000,
    100,
  );
  return c;
}

function worker(name: string, extra: Record<string, string> = {}): Child {
  return start(name, "worker", extra);
}

async function kill(c: Child) {
  c.expected = true;
  c.proc.kill("SIGKILL");
  await waitFor(`${c.name} to exit`, async () => c.exited, 10_000, 10);
  expect(c.exit?.signal).toBe("SIGKILL");
}

function stopAll() {
  for (const c of children) {
    c.expected = true;
    if (!c.exited) c.proc.kill("SIGKILL");
  }
}

beforeAll(async () => {
  const tb = await startTigerBeetle();
  if (!tb) return;
  tbAddress = tb.address;
  stopTb = tb.stop;
  // Compile what the image runs, so the children are the real thing and not a test double.
  mkdirSync(distDir, { recursive: true });
  execFileSync(
    join(root, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.build.json", "--outDir", distDir],
    { cwd: root, stdio: "pipe" },
  );
  copyFileSync(join(root, "src", "schema.sql"), join(distDir, "schema.sql"));
  const fresh = await freshDb();
  dbUrl = fresh.url;
  db = connect(dbUrl, 4);
  apiPort = await freePort();
  fake = await startFake(apiUrl());
  await seedDemo(db, systemClock, fake.url);
  ledgerClient = createClient({ cluster_id: 0n, replica_addresses: [tbAddress] });
  coins = new TigerBeetleCoinLedger(ledgerClient, 2000);
  ready = true;
}, 120_000);

/** Whatever a test did, its children must be dead before the next one starts. */
afterEach(async () => {
  stopAll();
  await waitFor("the children to exit", async () => children.every((c) => c.exited), 10_000, 20);
});

afterAll(async () => {
  stopAll();
  await fake?.close();
  ledgerClient?.destroy();
  await db?.end();
  stopTb?.();
});

// ---- helpers --------------------------------------------------------------------------

const post = (path: string, body: unknown) =>
  fetch(`${fake.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const bearer = (tenantId: string, externalId: string) =>
  `Bearer ${tokenFor(tenantId, tenantOf(tenantId).tokenSecret, externalId, Date.now())}`;

interface Pl extends JudgedPlayer {
  uuid: string;
}

async function newPlayer(tenantId: string, initialCoins: bigint): Promise<Pl> {
  const externalId = `proc-${randomUUID()}`;
  const r = await fetch(`${apiUrl()}/me`, { headers: { authorization: bearer(tenantId, externalId) } });
  expect(r.status).toBe(200);
  const uuid = ((await r.json()) as { playerId: string }).playerId;
  if (initialCoins > 0n) {
    await coins.creditPrize({
      ledgerNo: tenantOf(tenantId).ledgerNo,
      playerId: uuid,
      spinId: randomUUID(),
      coins: initialCoins,
    });
  }
  return { tenantId, externalId, creditedCoins: initialCoins, uuid };
}

async function itemId(tenantId: string, code: string): Promise<string> {
  const r = await db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = $2", [tenantId, code]);
  return r.rows[0].id;
}

async function redeem(p: Pl, item: string) {
  const r = await fetch(`${apiUrl()}/store/redemptions`, {
    method: "POST",
    headers: {
      authorization: bearer(p.tenantId, p.externalId),
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ itemId: item }),
  });
  if (r.status !== 201) {
    const logs = children.flatMap((c) =>
      c.lines
        .filter((l) => /deadlock|error|unhandled|detail|where:|Process \d+|Key/i.test(l))
        .map((l) => `${c.name}: ${l}`),
    );
    throw new Error(`redeem answered ${r.status}: ${await r.text()}\n${logs.slice(-14).join("\n")}`);
  }
  return (await r.json()) as { id: string; status: string };
}

const deliver = () => post("/control/b/deliver", {}).catch(() => undefined);

const ids = (ps: Pl[]) => ps.map((p) => p.uuid);

async function openRedemptions(ps: Pl[]): Promise<number> {
  const r = await db.query(
    `SELECT count(*) FROM redemptions WHERE player_id = ANY($1::uuid[])
     AND (settled_at IS NULL OR status NOT IN ('issued', 'refused', 'insufficient'))`,
    [ids(ps)],
  );
  return Number(r.rows[0].count);
}

/** Waits until every redemption of these players is final and settled, delivering platform B callbacks. */
async function untilFinal(ps: Pl[], timeoutMs: number) {
  await waitFor(
    "every redemption to be final and settled",
    async () => {
      await deliver();
      return (await openRedemptions(ps)) === 0;
    },
    timeoutMs,
    150,
  );
}

async function verdict(ps: Pl[]) {
  // The judge reads balances through `app.get(COIN_LEDGER)`; here the ledger is the test's own client.
  const running = { db, app: { get: () => coins } } as unknown as Parameters<typeof collect>[0];
  return judge(await collect(running, { url: fake.url }, ps));
}

const claimed = async () =>
  (
    await db.query(
      "SELECT id, kind, ref_id, claim_token FROM outbox WHERE claim_token IS NOT NULL AND done_at IS NULL ORDER BY id",
    )
  ).rows as { id: string; kind: string; ref_id: string; claim_token: string }[];

async function reset() {
  await post("/control/reset", {});
  await db.query("UPDATE outbox SET done_at = now() WHERE done_at IS NULL");
}

/** How many calls that issue a reward were made for each redemption (from our own audit rows). */
async function issueCalls(redemptionIds: string[]): Promise<Map<string, number>> {
  const r = await db.query(
    `SELECT entity_id, count(*) AS n FROM audit_log
     WHERE action = 'platform_call' AND entity_type = 'redemption' AND entity_id = ANY($1::text[])
       AND changes ->> 'call' = 'issue' AND changes ->> 'outcome' IS NOT NULL
     GROUP BY entity_id`,
    [redemptionIds],
  );
  return new Map(r.rows.map((x) => [x.entity_id as string, Number(x.n)]));
}

const redemptionIdsOf = async (ps: Pl[]) =>
  (await db.query("SELECT id FROM redemptions WHERE player_id = ANY($1::uuid[])", [ids(ps)])).rows.map(
    (r) => r.id as string,
  );

// ---- the tests ------------------------------------------------------------------------

describe.skipIf(process.env.TB_BIN === undefined && process.env.TB_ADDRESS === undefined)(
  "real processes",
  () => {
    test("A. a worker is killed while it holds claimed jobs: two new workers finish them, the judge is clean", async () => {
      expect(ready).toBe(true);
      await reset();
      // Inline jobs off: the API only writes; the one worker runs the jobs, so any claim is its claim.
      await startApi("api", { INLINE_JOBS: "off" });
      const players: Pl[] = [];
      for (const tenantId of [ALPHA, BETA]) {
        for (let i = 0; i < 5; i++) players.push(await newPlayer(tenantId, 1000n));
      }
      // The casino records the grant at once and answers 2.5 s later; our limit is 1 s. So the handler
      // is in flight for about a second and the grant exists when it is killed.
      for (const point of ["a.grant", "b.grant"]) {
        expect(
          (await post("/control/faults", { point, fault: "slow_answer", times: 50, delayMs: 2500 })).status,
        ).toBe(200);
      }
      const w1 = worker("worker-1");
      const item = (p: Pl) => itemId(p.tenantId, "bonus-1-eur");
      for (const p of players) await redeem(p, await item(p));

      await waitFor("worker-1 to hold a claim", async () => (await claimed()).length > 0, 30_000, 10);
      await kill(w1);
      const orphans = await claimed(); // taken after the death: nothing can finish them now
      expect(orphans.length, "no claim was left behind at the kill: the test proves nothing").toBeGreaterThan(
        0,
      );

      // Two new workers. The orphans become due when the lease ends (3 s).
      worker("worker-2");
      worker("worker-3");
      await untilFinal(players, 45_000);

      const after = await db.query(
        "SELECT id, done_at, dead_at, claim_token FROM outbox WHERE id = ANY($1::bigint[])",
        [orphans.map((o) => o.id)],
      );
      for (const row of after.rows) {
        expect(row.done_at, `orphaned job ${row.id} was not finished by another worker`).not.toBeNull();
        expect(row.dead_at).toBeNull();
        expect(row.claim_token).toBeNull();
      }
      expect(await verdict(players)).toEqual([]);
      const issued = (
        await db.query(
          "SELECT count(*) FROM redemptions WHERE player_id = ANY($1::uuid[]) AND status = 'issued'",
          [ids(players)],
        )
      ).rows[0].count;
      expect(Number(issued)).toBe(players.length); // nobody was refused: all ten ended issued
      console.log(
        `A: ${orphans.length} jobs were left claimed by the killed worker; all finished by the others`,
      );
    }, 90_000);

    test("B. the API is killed after the request committed and before any job ran: workers finish the rest", async () => {
      expect(ready).toBe(true);
      children.length = 0;
      await reset();
      const api = await startApi("api-1", { INLINE_JOBS: "off" });
      const players: Pl[] = [];
      for (const tenantId of [ALPHA, BETA]) {
        for (let i = 0; i < 5; i++) players.push(await newPlayer(tenantId, 1000n));
      }
      for (const p of players) {
        const r = await redeem(p, await itemId(p.tenantId, "bonus-1-eur"));
        expect(r.status).toBe("created"); // committed, nothing has run
      }
      const open = await db.query(
        "SELECT count(*) FROM outbox WHERE kind = 'redemption_advance' AND done_at IS NULL AND claim_token IS NULL AND ref_id = ANY($1::uuid[])",
        [await redemptionIdsOf(players)],
      );
      expect(Number(open.rows[0].count)).toBe(players.length);
      await kill(api);

      // No API is alive. Workers alone can finish platform A; platform B waits for its callback.
      worker("worker-1");
      worker("worker-2");
      const alphaPlayers = players.filter((p) => p.tenantId === ALPHA);
      await untilFinal(alphaPlayers, 30_000);
      expect((await openRedemptions(players.filter((p) => p.tenantId === BETA))) > 0).toBe(true);

      // The API comes back (same address: the casino sends its callbacks there) and B finishes.
      await startApi("api-2", { INLINE_JOBS: "off" });
      await untilFinal(players, 30_000);
      expect(await verdict(players)).toEqual([]);
      const dead = await db.query("SELECT count(*) FROM outbox WHERE dead_at IS NOT NULL");
      expect(Number(dead.rows[0].count)).toBe(0);
    }, 90_000);

    test("D. a handler that outlives its lease: the second worker takes over, the first is fenced out, platform A still has one grant each", async () => {
      expect(ready).toBe(true);
      await reset();
      await startApi("api", { INLINE_JOBS: "off" });
      const players: Pl[] = [];
      for (let i = 0; i < 4; i++) players.push(await newPlayer(ALPHA, 1000n));
      // A look takes 2 s; the lease is 1 s and the platform limit 2.5 s, so every handler outlives its lease.
      expect(
        (await post("/control/faults", { point: "a.find", fault: "slow_answer", times: 1000, delayMs: 2000 }))
          .status,
      ).toBe(200);
      const slow = { OUTBOX_LEASE_MS: "1000", PLATFORM_TIMEOUT_MS: "2500" };
      worker("worker-1", slow);
      worker("worker-2", slow);
      const made = [];
      for (const p of players) made.push(await redeem(p, await itemId(p.tenantId, "bonus-1-eur")));
      await untilFinal(players, 45_000);
      expect(await verdict(players)).toEqual([]);
      const lost = children.flatMap((c) => c.lines).filter((l) => l.includes("outbox.lease_lost"));
      expect(lost.length, "no finish was fenced out (outbox.lease_lost was never logged)").toBeGreaterThan(0);
      const grants = (await (await fetch(`${fake.url}/control/state`)).json()) as {
        grants: { reference: string }[];
      };
      for (const m of made) expect(grants.grants.filter((g) => g.reference === m.id)).toHaveLength(1);
      console.log(`D: ${lost.length} finishes were fenced out`);
    }, 90_000);

    test("C. three workers, 30 spins and 30 redemptions, no kills: every redemption is issued once, every job is done", async () => {
      expect(ready).toBe(true);
      children.length = 0;
      await reset();
      await startApi("api", { INLINE_JOBS: "off" });
      worker("worker-1");
      worker("worker-2");
      worker("worker-3");
      // Slow lookups keep handlers running long enough for the three workers to overlap in time.
      for (const point of ["a.find", "b.find"]) {
        expect(
          (await post("/control/faults", { point, fault: "slow_answer", times: 1000, delayMs: 300 })).status,
        ).toBe(200);
      }
      const players: Pl[] = [];
      for (const tenantId of [ALPHA, BETA]) {
        for (let i = 0; i < 15; i++) players.push(await newPlayer(tenantId, 1000n));
      }
      // 30 deposits, one spin each, all at once.
      await Promise.all(
        players.map(async (p) => {
          const d = await post("/control/deposit", {
            tenantId: p.tenantId,
            playerId: p.externalId,
            amount: "20.00",
            eventId: `ev-${randomUUID()}`,
          });
          expect(d.status).toBe(200);
        }),
      );
      await Promise.all(
        players.map(async (p) => {
          const me = await fetch(`${apiUrl()}/me`, {
            headers: { authorization: bearer(p.tenantId, p.externalId) },
          });
          const spins = ((await me.json()) as { spins: { id: string; status: string }[] }).spins;
          const open = spins.find((s) => s.status === "available");
          if (!open) throw new Error(`no spin for ${p.externalId}`);
          const r = await fetch(`${apiUrl()}/wheel/spins/${open.id}/spin`, {
            method: "POST",
            headers: { authorization: bearer(p.tenantId, p.externalId) },
          });
          expect(r.status).toBe(200);
          p.creditedCoins += BigInt(((await r.json()) as { coins: string | number }).coins);
        }),
      );
      // 30 redemptions at once.
      const made = await Promise.all(
        players.map(async (p) => redeem(p, await itemId(p.tenantId, "bonus-1-eur"))),
      );
      await untilFinal(players, 45_000);

      expect(await verdict(players)).toEqual([]);
      // Every job of these players is done, none dead, and nobody lost a lease.
      const jobs = await db.query(
        `SELECT kind, count(*) AS n, count(*) FILTER (WHERE done_at IS NOT NULL) AS done,
                count(*) FILTER (WHERE dead_at IS NOT NULL) AS dead
         FROM outbox GROUP BY kind`,
      );
      for (const j of jobs.rows) {
        expect(Number(j.done), `jobs of kind ${j.kind}`).toBe(Number(j.n));
        expect(Number(j.dead)).toBe(0);
      }
      expect(jobs.rows.map((j) => j.kind)).toContain("redemption_advance");
      // One call that issues a reward per redemption: a job that ran twice at once would call twice.
      const calls = await issueCalls(made.map((m) => m.id));
      for (const m of made) expect(calls.get(m.id), `issue calls for ${m.id}`).toBe(1);
      const lost = children.flatMap((c) => c.lines).filter((l) => l.includes("outbox.lease_lost"));
      expect(lost).toEqual([]);
    }, 90_000);
  },
);
