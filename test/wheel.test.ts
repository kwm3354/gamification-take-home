import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { create, update } from "../src/audit/audited.ts";
import { transaction } from "../src/db.ts";
import { COIN_LEDGER, type CoinLedger, LedgerUnavailable } from "../src/domain/coin-ledger.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { demoTenants, demoWheelSegments } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { pickSegment } from "../src/wheel/pick-segment.ts";
import { type TestApp, startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { tokenFor } from "./signing.ts";

// The whole app over real HTTP, a real PostgreSQL, a real TigerBeetle, the fake casino as event source.
// Skipped when no TigerBeetle is available.
const running = await startApp();
const crashing = await startApp({ config: { inlineJobs: false } });
const fake = running ? await startFake(running.url) : undefined;
const crashFake = crashing ? await startFake(crashing.url) : undefined;

const tenant = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};
const alpha = tenant("alpha-casino");
const beta = tenant("beta-casino");

beforeAll(async () => {
  if (running) await seedDemo(running.db, running.clock, "http://127.0.0.1:1");
  if (crashing) await seedDemo(crashing.db, crashing.clock, "http://127.0.0.1:1");
});
afterAll(async () => {
  await running?.close();
  await crashing?.close();
  await fake?.close();
  await crashFake?.close();
});

type Env = { app: TestApp; casino: NonNullable<typeof fake> };
const main = (): Env => {
  if (!running || !fake) throw new Error("no app");
  return { app: running, casino: fake };
};
const crash = (): Env => {
  if (!crashing || !crashFake) throw new Error("no app");
  return { app: crashing, casino: crashFake };
};

const freshPlayer = () => `p-${randomUUID()}`;

async function deposit(env: Env, tenantId: string, playerId: string, amount = "20.00", currency = "EUR") {
  const r = await fetch(`${env.casino.url}/control/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId, playerId, amount, currency }),
  });
  expect(r.status).toBe(200);
}
async function tokenOf(env: Env, tenantId: string, playerId: string): Promise<string> {
  const r = await fetch(`${env.casino.url}/control/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId, playerId }),
  });
  return ((await r.json()) as { token: string }).token;
}

interface Me {
  playerId: string;
  tenantId: string;
  balance: { available: string; reserved: string } | null;
  spins: { id: string; status: string; coins: string | null }[];
}
async function me(env: Env, token: string): Promise<Me> {
  const r = await fetch(`${env.app.url}/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
  return (await r.json()) as Me;
}
async function postSpin(env: Env, token: string | undefined, spinId: string, body?: unknown) {
  const r = await fetch(`${env.app.url}/wheel/spins/${spinId}/spin`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
}

/** A new player with one spin: returns the token and the spin id. */
async function playerWithSpin(env: Env, tenantId: string) {
  const external = freshPlayer();
  await deposit(env, tenantId, external);
  const token = await tokenOf(env, tenantId, external);
  const m = await me(env, token);
  expect(m.spins).toHaveLength(1);
  return { token, external, ourId: m.playerId, spinId: (m.spins[0] as { id: string }).id };
}

const wheelSecretOf = (tenantId: string) => tenant(tenantId).wheelSecret;
const spinRow = async (env: Env, spinId: string) =>
  (await env.app.db.query("SELECT * FROM spins WHERE id = $1", [spinId])).rows[0];

describe("pickSegment", () => {
  const segments = demoWheelSegments;

  test("known secret and spin id give a stable index", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const first = pickSegment("secret-a", id, segments);
    expect(pickSegment("secret-a", id, segments)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(segments.length);
  });

  test("over 20,000 random spin ids each share is within 2 points of its weight", () => {
    const counts = segments.map(() => 0);
    for (let i = 0; i < 20_000; i++) {
      const k = pickSegment("secret-a", randomUUID(), segments);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const total = segments.reduce((s, x) => s + x.weight, 0);
    segments.forEach((s, i) => {
      const share = ((counts[i] as number) / 20_000) * 100;
      expect(Math.abs(share - (s.weight / total) * 100)).toBeLessThan(2);
    });
  });

  test("another secret gives other outcomes", () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    const differ = ids.filter(
      (id) => pickSegment("secret-a", id, segments) !== pickSegment("secret-b", id, segments),
    );
    expect(differ.length).toBeGreaterThan(20);
  });

  test("bad tables are refused", () => {
    expect(() => pickSegment("s", "x", [])).toThrow();
    expect(() => pickSegment("s", "x", [{ label: "a", coins: 1, weight: 0 }])).toThrow();
    expect(() => pickSegment("s", "x", [{ label: "a", coins: 1, weight: 1.5 }])).toThrow();
    expect(() => pickSegment("s", "x", [{ label: "a", coins: 1, weight: -1 }])).toThrow();
  });
});

describe.skipIf(!running)("wheel over HTTP", () => {
  test("1. happy path on platform A and on platform B", async () => {
    for (const t of [alpha, beta]) {
      const env = main();
      const p = await playerWithSpin(env, t.id);
      const before = await me(env, p.token);
      expect(before.balance).toEqual({ available: "0", reserved: "0" });
      expect(before.spins[0]).toMatchObject({ status: "available", coins: null });

      const res = await postSpin(env, p.token, p.spinId);
      expect(res.status).toBe(200);
      const segment = demoWheelSegments[res.json.segmentIndex];
      expect(segment).toBeDefined();
      expect(res.json).toEqual({
        spinId: p.spinId,
        segmentIndex: res.json.segmentIndex,
        label: segment?.label,
        coins: segment?.coins,
      });

      const after = await me(env, p.token);
      expect(after.spins[0]).toMatchObject({ status: "used", coins: String(segment?.coins) });
      expect(after.balance).toEqual({ available: String(segment?.coins), reserved: "0" });
    }
  });

  test("2. twenty identical requests at once: same body, exactly one prize in the ledger, one use in the audit", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    // Every clock reading differs, so a request that wrongly "used" the spin again would leave a trace.
    const clock = env.app.clock;
    const realNow = clock.now.bind(clock);
    let ticks = 0;
    clock.now = () => new Date(realNow().getTime() + ticks++);
    let answers: Awaited<ReturnType<typeof postSpin>>[];
    try {
      answers = await Promise.all(Array.from({ length: 20 }, () => postSpin(env, p.token, p.spinId)));
    } finally {
      clock.now = realNow;
    }
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(new Set(answers.map((a) => a.text)).size).toBe(1);
    const m = await me(env, p.token);
    expect(m.balance?.available).toBe(String(answers[0]?.json.coins));
    expect(m.spins[0]?.status).toBe("used");
    const audit = await env.app.db.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'spins' AND entity_id = $1",
      [p.spinId],
    );
    expect(audit.rows[0].n).toBe(3); // create, used, credited
  });

  test("2b. requests blocked on the row lock while another use commits: they change and credit nothing", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    const index = pickSegment(alpha.wheelSecret, p.spinId, demoWheelSegments);
    const coins = demoWheelSegments[index]?.coins;
    const clock = env.app.clock;
    const realNow = clock.now.bind(clock);
    let ticks = 0;
    clock.now = () => new Date(realNow().getTime() + ticks++); // every reading differs
    try {
      // Another transaction uses the spin and holds the lock while three requests arrive.
      const holder = await env.app.db.connect();
      await holder.query("BEGIN");
      await update(
        holder,
        { tenantId: alpha.id, actor: "test/holder", now: realNow() },
        "spins",
        p.spinId,
        () => ({ status: "used", segment_index: index, coins, used_at: realNow() }),
      );
      const requests = Array.from({ length: 3 }, () => postSpin(env, p.token, p.spinId));
      await new Promise<void>((resolve) => {
        const poll = async () => {
          const r = await env.app.db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM spins%FOR UPDATE%'",
          );
          if (r.rows[0].n >= 3) resolve();
          else setImmediate(poll);
        };
        void poll();
      });
      await holder.query("COMMIT");
      holder.release();
      const answers = await Promise.all(requests);
      expect(answers.every((a) => a.status === 200 && a.json.coins === coins)).toBe(true);
    } finally {
      clock.now = realNow;
    }
    const audit = await env.app.db.query(
      "SELECT actor FROM audit_log WHERE entity_type = 'spins' AND entity_id = $1 ORDER BY id",
      [p.spinId],
    );
    expect(audit.rows.map((r) => r.actor)).toEqual(["platform/alpha-casino", "test/holder"]);
    // The repeats made sure the job exists; it credits once.
    clock.advance(1000); // the job was queued at a ticked time
    await env.app.app.get<Outbox>(OUTBOX).runDue();
    expect((await me(env, p.token)).balance?.available).toBe(String(coins));
  });

  test("3. a repeat later and the outbox job after the inline credit change nothing", async () => {
    const env = main();
    const p = await playerWithSpin(env, beta.id);
    const first = await postSpin(env, p.token, p.spinId);
    const balance = (await me(env, p.token)).balance;
    const rowBefore = await spinRow(env, p.spinId);
    const auditCount = async () =>
      (
        await env.app.db.query(
          "SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'spins' AND entity_id = $1",
          [p.spinId],
        )
      ).rows[0].n;
    const auditBefore = await auditCount();

    env.app.clock.advance(5000); // a changed used_at would show if the repeat wrote anything
    const again = await postSpin(env, p.token, p.spinId);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    // The job queued by the spin is still due; running it after the inline credit must not credit twice.
    await env.app.app.get<Outbox>(OUTBOX).runDue();

    expect((await me(env, p.token)).balance).toEqual(balance);
    const rowAfter = await spinRow(env, p.spinId);
    expect(rowAfter.used_at).toEqual(rowBefore.used_at);
    expect(rowAfter.credited_at).toEqual(rowBefore.credited_at);
    expect(await auditCount()).toBe(auditBefore);
  });

  test("4. the HTTP result equals pickSegment from the seeded secret, spin id and table", async () => {
    for (const t of [alpha, beta]) {
      const env = main();
      const p = await playerWithSpin(env, t.id);
      const res = await postSpin(env, p.token, p.spinId);
      expect(res.json.segmentIndex).toBe(pickSegment(wheelSecretOf(t.id), p.spinId, demoWheelSegments));
    }
  });

  test("5. the client cannot choose the outcome", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    const res = await postSpin(env, p.token, p.spinId, { segmentIndex: 3, coins: 500 });
    expect(res.status).toBe(200);
    expect(res.json.segmentIndex).toBe(pickSegment(alpha.wheelSecret, p.spinId, demoWheelSegments));
    const row = await spinRow(env, p.spinId);
    expect(row.segment_index).toBe(res.json.segmentIndex);
    expect(Number(row.coins)).toBe(demoWheelSegments[res.json.segmentIndex]?.coins);
  });

  test("7. the ledger is away at spin time: still 200, the queued job credits later", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    const ledger = env.app.app.get<CoinLedger>(COIN_LEDGER);
    const original = ledger.creditPrize.bind(ledger);
    let failed = 0;
    ledger.creditPrize = async (input) => {
      if (failed === 0) {
        failed++;
        throw new LedgerUnavailable("test: ledger away");
      }
      return original(input);
    };
    try {
      const res = await postSpin(env, p.token, p.spinId);
      expect(res.status).toBe(200);
      expect(failed).toBe(1);
      expect((await me(env, p.token)).balance?.available).toBe("0");
      expect((await spinRow(env, p.spinId)).credited_at).toBeNull();

      env.app.clock.advance(2000);
      const outbox = env.app.app.get<Outbox>(OUTBOX);
      await outbox.runDue();
      expect((await me(env, p.token)).balance?.available).toBe(String(res.json.coins));
      expect((await spinRow(env, p.spinId)).credited_at).not.toBeNull();
    } finally {
      ledger.creditPrize = original;
    }
  });

  test("7b. a long ledger outage never kills the spin_credit job; the prize is credited once when the ledger returns", async () => {
    const env = main();
    // Not a clock jump: the shared fake clock also checks player tokens, and a jump would expire them for later tests.
    const makeDue = (env: Env, spinId: string) =>
      env.app.db.query("UPDATE outbox SET run_at = '2000-01-01' WHERE kind = 'spin_credit' AND ref_id = $1", [
        spinId,
      ]);
    const p = await playerWithSpin(env, alpha.id);
    const ledger = env.app.app.get<CoinLedger>(COIN_LEDGER);
    const original = ledger.creditPrize.bind(ledger);
    let down = true;
    let calls = 0;
    ledger.creditPrize = async (input) => {
      calls++;
      if (down) throw new LedgerUnavailable("test: ledger away");
      return original(input);
    };
    try {
      const res = await postSpin(env, p.token, p.spinId);
      expect(res.status).toBe(200);
      const outbox = env.app.app.get<Outbox>(OUTBOX);
      for (let run = 0; run < 13; run++) {
        await makeDue(env, p.spinId);
        await outbox.runDue();
      }
      expect(calls).toBeGreaterThan(10);
      const job = await env.app.db.query(
        "SELECT dead_at, done_at FROM outbox WHERE kind = 'spin_credit' AND ref_id = $1",
        [p.spinId],
      );
      expect(job.rows[0].dead_at).toBeNull();
      expect(job.rows[0].done_at).toBeNull();
      down = false;
      await makeDue(env, p.spinId);
      await outbox.runDue();
      const token = p.token;
      expect((await me(env, token)).balance?.available).toBe(String(res.json.coins));
      expect((await spinRow(env, p.spinId)).credited_at).not.toBeNull();
      await makeDue(env, p.spinId);
      await outbox.runDue();
      expect((await me(env, token)).balance?.available).toBe(String(res.json.coins));
    } finally {
      ledger.creditPrize = original;
    }
  });

  test("8. someone else's spin is a 404 and stays available", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    const sameTenant = await tokenOf(env, alpha.id, freshPlayer());
    const otherTenant = await tokenOf(env, beta.id, p.external); // same external id, other tenant
    expect((await postSpin(env, sameTenant, p.spinId)).status).toBe(404);
    expect((await postSpin(env, otherTenant, p.spinId)).status).toBe(404);
    expect((await spinRow(env, p.spinId)).status).toBe("available");
    expect((await postSpin(env, p.token, p.spinId)).status).toBe(200);
  });

  test("10. no token or a bad token is 401; unknown or malformed spin id is 404", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    expect((await postSpin(env, undefined, p.spinId)).status).toBe(401);
    expect((await postSpin(env, "garbage", p.spinId)).status).toBe(401);
    const forged = tokenFor(alpha.id, "wrong-secret", p.external, env.app.clock.now().getTime());
    expect((await postSpin(env, forged, p.spinId)).status).toBe(401);
    expect((await postSpin(env, p.token, randomUUID())).status).toBe(404);
    expect((await postSpin(env, p.token, "not-a-uuid")).status).toBe(404);
    expect((await spinRow(env, p.spinId)).status).toBe("available");
    const wheel = await fetch(`${env.app.url}/wheel`);
    expect(wheel.status).toBe(401);
  });

  test("11. audit trail of one spin: create, used by the player, credited by the outbox", async () => {
    const env = main();
    const p = await playerWithSpin(env, alpha.id);
    await postSpin(env, p.token, p.spinId);
    const rows = (
      await env.app.db.query(
        "SELECT actor, action, changes FROM audit_log WHERE entity_type = 'spins' AND entity_id = $1 ORDER BY id",
        [p.spinId],
      )
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(["create", "update", "update"]);
    expect(rows[0].actor).toBe("platform/alpha-casino");
    expect(rows[1].actor).toBe(`player/${p.ourId}`);
    expect(rows[1].changes).toContainEqual({ field: "status", from: "available", to: "used" });
    expect(rows[2].actor).toBe("system/outbox");
    expect(rows[2].changes.map((c: { field: string }) => c.field)).toEqual(["credited_at"]);
  });

  test("GET /wheel shows labels and coins, no weights", async () => {
    const env = main();
    const token = await tokenOf(env, alpha.id, freshPlayer());
    const r = await fetch(`${env.app.url}/wheel`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      version: 1,
      segments: demoWheelSegments.map((s) => ({ label: s.label, coins: s.coins })),
    });
  });

  test("GET /me answers 200 with balance null when the ledger does not answer", async () => {
    const env = main();
    const token = await tokenOf(env, alpha.id, freshPlayer());
    const ledger = env.app.app.get<CoinLedger>(COIN_LEDGER);
    const original = ledger.balance.bind(ledger);
    ledger.balance = async () => {
      throw new LedgerUnavailable("test: ledger away");
    };
    try {
      const r = await fetch(`${env.app.url}/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as Me).balance).toBeNull();
    } finally {
      ledger.balance = original;
    }
  });

  test("9. wheel config versions: an old spin keeps version 1, a new deposit gets version 2", async () => {
    const env = main();
    const old = await playerWithSpin(env, alpha.id);
    await transaction(env.app.db, (tx) =>
      create(tx, { tenantId: alpha.id, actor: "admin/test", now: env.app.clock.now() }, "wheel_configs", {
        tenant_id: alpha.id,
        version: 2,
        segments: [{ label: "7 coins", coins: 7, weight: 1 }],
      }),
    );
    const token = await tokenOf(env, alpha.id, old.external);
    const wheel = await (
      await fetch(`${env.app.url}/wheel`, { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(wheel).toEqual({ version: 2, segments: [{ label: "7 coins", coins: 7 }] });

    const oldRes = await postSpin(env, old.token, old.spinId);
    expect(oldRes.json.segmentIndex).toBe(pickSegment(alpha.wheelSecret, old.spinId, demoWheelSegments));
    expect(oldRes.json.label).toBe(demoWheelSegments[oldRes.json.segmentIndex]?.label);

    const fresh = await playerWithSpin(env, alpha.id);
    const freshRes = await postSpin(env, fresh.token, fresh.spinId);
    expect(freshRes.json).toEqual({ spinId: fresh.spinId, segmentIndex: 0, label: "7 coins", coins: 7 });
    // The other tenant still has only version 1.
    const betaP = await playerWithSpin(env, beta.id);
    const betaRes = await postSpin(env, betaP.token, betaP.spinId);
    expect(demoWheelSegments.map((s) => s.label)).toContain(betaRes.json.label);
  });
});

describe.skipIf(!crashing)("wheel without inline jobs", () => {
  test("6. the process dies after the commit: spin answers, ledger is credited by the job, once", async () => {
    const env = crash();
    const p = await playerWithSpin(env, alpha.id);
    const res = await postSpin(env, p.token, p.spinId);
    expect(res.status).toBe(200);
    expect((await me(env, p.token)).balance?.available).toBe("0");
    expect((await spinRow(env, p.spinId)).credited_at).toBeNull();

    const outbox = env.app.app.get<Outbox>(OUTBOX);
    expect(await outbox.runDue()).toBeGreaterThanOrEqual(1);
    expect((await me(env, p.token)).balance?.available).toBe(String(res.json.coins));
    expect((await spinRow(env, p.spinId)).credited_at).not.toBeNull();

    await outbox.runDue();
    expect((await me(env, p.token)).balance?.available).toBe(String(res.json.coins));
    // A repeat of the request after the credit changes nothing either.
    expect((await postSpin(env, p.token, p.spinId)).text).toBe(res.text);
    await outbox.runDue();
    expect((await me(env, p.token)).balance?.available).toBe(String(res.json.coins));
  });
});
