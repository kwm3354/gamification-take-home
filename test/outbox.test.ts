import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { FakeClock } from "../src/clock.ts";
import { type Db, transaction } from "../src/db.ts";
import { Log, MemorySink } from "../src/logging/log.ts";
import { Outbox } from "../src/outbox/outbox.ts";
import { freshDb } from "./harness.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

/** A fresh database, clock and job id per test, so tests do not see each other's rows. */
async function setup() {
  const fresh = await freshDb();
  closers.push(fresh.close);
  const db = fresh.db;
  await db.query(
    `INSERT INTO tenants (id, name, platform, ledger_no, webhook_secret, token_secret, wheel_secret, platform_url, platform_key)
     VALUES ('t1', 'T1', 'A', 1, 'a', 'b', 'c', 'http://x', 'k')`,
  );
  const clock = new FakeClock();
  const outbox = new Outbox(db, clock);
  const refId = randomUUID();
  const enqueue = (runAt?: Date, kind = "k", ref = refId) =>
    transaction(db, (tx) => outbox.enqueue(tx, { tenantId: "t1", kind, refId: ref, runAt }));
  const row = async () =>
    (await db.query("SELECT * FROM outbox WHERE kind = 'k' AND ref_id = $1", [refId])).rows[0];
  return { db, clock, outbox, refId, enqueue, row };
}

describe("outbox", () => {
  test("enqueueing twice makes one row", async () => {
    const { db, enqueue, refId } = await setup();
    await enqueue();
    await enqueue();
    const { rows } = await db.query("SELECT 1 FROM outbox WHERE ref_id = $1", [refId]);
    expect(rows).toHaveLength(1);
  });

  test("a job that is not due yet runs only after the clock moves", async () => {
    const { clock, outbox, enqueue } = await setup();
    let runs = 0;
    outbox.handle("k", async () => {
      runs++;
      return "done";
    });
    await enqueue(new Date(clock.now().getTime() + 5000));
    expect(await outbox.runDue()).toBe(0);
    clock.advance(4999);
    expect(await outbox.runDue()).toBe(0);
    clock.advance(1);
    expect(await outbox.runDue()).toBe(1);
    expect(runs).toBe(1);
    expect(await outbox.runDue()).toBe(0);
  });

  test("a handler that throws is retried after 1 s, 2 s and 4 s", async () => {
    const { clock, outbox, enqueue, row } = await setup();
    let runs = 0;
    outbox.handle("k", async () => {
      runs++;
      throw new Error("boom");
    });
    await enqueue();
    expect(await outbox.runDue()).toBe(1);
    expect(runs).toBe(1);
    expect((await row()).last_error).toBe("boom");

    for (const [delay, expectedRuns] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
    ] as const) {
      clock.advance(delay - 1);
      expect(await outbox.runDue()).toBe(0);
      clock.advance(1);
      expect(await outbox.runDue()).toBe(1);
      expect(runs).toBe(expectedRuns);
    }
  });

  test("after 10 failed runs the job is dead and no longer runs", async () => {
    const { clock, outbox, enqueue, row } = await setup();
    let runs = 0;
    outbox.handle("k", async () => {
      runs++;
      throw new Error("always");
    });
    await enqueue();
    for (let i = 0; i < 10; i++) {
      expect(await outbox.runDue()).toBe(1);
      clock.advance(60_000);
    }
    expect(runs).toBe(10);
    const after = await row();
    expect(after.dead_at).not.toBeNull();
    expect(after.done_at).toBeNull();
    expect(after.attempts).toBe(10);
    expect(after.last_error).toBe("always");
    expect(await outbox.runDue()).toBe(0);
    expect(runs).toBe(10);
  });

  test("enqueueing a dead job again revives it and logs outbox.revived with the last error; a done job logs nothing", async () => {
    const { db, clock, refId, enqueue, row } = await setup();
    const sink = new MemorySink();
    const outbox = new Outbox(db, clock, new Log(sink, clock, () => "info"));
    const events = () => sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    let fails = true;
    let runs = 0;
    outbox.handle("k", async () => {
      runs++;
      if (fails) throw new Error("always");
      return "done";
    });
    await enqueue();
    for (let i = 0; i < 10; i++) {
      await outbox.runDue();
      clock.advance(60_000);
    }
    expect((await row()).dead_at).not.toBeNull();
    expect(events().map((e) => e.event)).toEqual(["outbox.dead"]);

    // A new request for the same job is a legitimate reason to try again, but the log says it was dead.
    await transaction(db, (tx) => outbox.enqueue(tx, { tenantId: "t1", kind: "k", refId }));
    expect(events().filter((e) => e.event === "outbox.revived")).toEqual([
      expect.objectContaining({ level: "warn", tenantId: "t1", kind: "k", refId, previousError: "always" }),
    ]);
    fails = false;
    expect(await outbox.runDue()).toBe(1);
    expect(runs).toBe(11);
    expect((await row()).done_at).not.toBeNull();

    // Enqueueing a job that is done (not dead) writes no revived line.
    await transaction(db, (tx) => outbox.enqueue(tx, { tenantId: "t1", kind: "k", refId }));
    expect(events().filter((e) => e.event === "outbox.revived")).toHaveLength(1);
  });

  test("retryInMs reschedules and never makes the job dead", async () => {
    const { clock, outbox, enqueue, row } = await setup();
    let runs = 0;
    outbox.handle("k", async () => {
      runs++;
      return { retryInMs: 3000 };
    });
    await enqueue();
    for (let i = 0; i < 15; i++) {
      expect(await outbox.runDue()).toBe(1);
      clock.advance(2999);
      expect(await outbox.runDue()).toBe(0);
      clock.advance(1);
    }
    expect(runs).toBe(15);
    const after = await row();
    expect(after.dead_at).toBeNull();
    expect(after.done_at).toBeNull();
    expect(after.attempts).toBe(15);
  });

  test("two runDue calls at the same moment run a slow handler once", async () => {
    const { outbox, enqueue, row } = await setup();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    outbox.handle("k", async () => {
      runs++;
      if (runs > 1) return "done"; // a second run is the bug; do not hang on it, let the count show it
      started();
      await gate;
      return "done";
    });
    await enqueue();
    const first = outbox.runDue();
    await handlerStarted; // the first run holds the lease now
    // If the second run waited for the first, this watchdog frees the first run so the test can
    // fail instead of hanging. It does not fire when the claim skips a job that has a live lease.
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      release();
    }, 2000);
    const second = await outbox.runDue(); // must skip the locked row: not wait for it, not run it
    clearTimeout(watchdog);
    release();
    const firstRan = await first;
    expect(watchdogFired).toBe(false);
    expect(second).toBe(0);
    expect(firstRan).toBe(1);
    expect(runs).toBe(1);
    expect((await row()).done_at).not.toBeNull();
  });

  test("enqueueing a finished job makes it run again", async () => {
    const { outbox, enqueue, row } = await setup();
    let runs = 0;
    outbox.handle("k", async () => {
      runs++;
      return "done";
    });
    await enqueue();
    expect(await outbox.runDue()).toBe(1);
    expect(await outbox.runDue()).toBe(0);
    await enqueue();
    expect((await row()).done_at).toBeNull();
    expect(await outbox.runDue()).toBe(1);
    expect(runs).toBe(2);
  });

  test("a kind without a handler is recorded as a failure", async () => {
    const { outbox, enqueue, row } = await setup();
    await enqueue();
    expect(await outbox.runDue()).toBe(1);
    const after = await row();
    expect(after.last_error).toBe("no handler for k");
    expect(after.attempts).toBe(1);
    expect(after.done_at).toBeNull();
  });

  test("drain runs jobs that handlers enqueue, until nothing is due", async () => {
    const { db, outbox, enqueue, row } = await setup();
    outbox.handle("k", async () => {
      await transaction(db, (tx) => outbox.enqueue(tx, { tenantId: "t1", kind: "k2", refId: randomUUID() }));
      return "done";
    });
    outbox.handle("k2", async () => "done");
    await enqueue();
    await outbox.drain();
    expect((await row()).done_at).not.toBeNull();
    const { rows } = await db.query("SELECT done_at FROM outbox WHERE kind = 'k2'");
    expect(rows[0].done_at).not.toBeNull();
  });

  /** Sessions of this database that sit "idle in transaction", and row or table locks on outbox held by other sessions. */
  async function holdings(db: Db) {
    const idle = await db.query(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`,
    );
    const locks = await db.query(
      `SELECT l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
       WHERE c.relname = 'outbox' AND l.pid <> pg_backend_pid()`,
    );
    return { idle: idle.rowCount, locks: locks.rowCount };
  }

  /** A promise the test resolves by hand. */
  function latch() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  /** Waits for `promise` but fails the test after 3 s of real time instead of hanging. */
  async function within3s(promise: Promise<unknown>, what: string) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), 3000);
    });
    try {
      await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  test("while a handler runs, no session is idle in a transaction and no lock on outbox is held", async () => {
    const { db, outbox, enqueue } = await setup();
    const gate = latch();
    const inside = latch();
    outbox.handle("k", async () => {
      inside.open();
      await gate.promise;
      return "done";
    });
    await enqueue();
    const run = outbox.runDue();
    try {
      await within3s(inside.promise, "handler start");
      expect(await holdings(db)).toEqual({ idle: 0, locks: 0 });
    } finally {
      gate.open(); // so a failing run does not leave the handler hanging
    }
    expect(await run).toBe(1);
  });

  test("ten due jobs run at the same time", async () => {
    const { db, outbox, clock } = await setup();
    const gate = latch();
    const allIn = latch();
    let entered = 0;
    let atOnce = 0;
    let maxAtOnce = 0;
    outbox.handle("k", async () => {
      entered++;
      atOnce++;
      maxAtOnce = Math.max(maxAtOnce, atOnce);
      if (entered === 10) allIn.open();
      await gate.promise;
      atOnce--;
      return "done";
    });
    for (let i = 0; i < 10; i++) {
      await transaction(db, (tx) => outbox.enqueue(tx, { tenantId: "t1", kind: "k", refId: randomUUID() }));
    }
    const run = outbox.runDue();
    try {
      await within3s(allIn.promise, "all ten handlers inside");
      expect(maxAtOnce).toBe(10);
    } finally {
      gate.open();
    }
    expect(await run).toBe(10);
    expect(clock.now()).toBeInstanceOf(Date);
  });

  test("a lease that ran out: the second worker runs the job and the slow first worker is fenced out", async () => {
    const { db, clock, enqueue, row, refId } = await setup();
    const sink = new MemorySink();
    const log = new Log(sink, clock, () => "info");
    const a = new Outbox(db, clock, log, { leaseMs: 60_000 });
    const b = new Outbox(db, clock, log, { leaseMs: 60_000 });
    const gate = latch();
    const inside = latch();
    a.handle("k", async () => {
      inside.open();
      await gate.promise;
      return { retryInMs: 5000 }; // what A would write if it were not fenced out
    });
    let bRuns = 0;
    b.handle("k", async () => {
      bRuns++;
      return "done";
    });
    await enqueue();
    const runA = a.runDue();
    await within3s(inside.promise, "A inside");
    expect(await b.runDue()).toBe(0); // the claim is live
    clock.advance(60_001);
    expect(await b.runDue()).toBe(1);
    expect(bRuns).toBe(1);
    const afterB = await row();
    expect(afterB.done_at).not.toBeNull();
    gate.open();
    await runA;
    const after = await row();
    expect(after.done_at).not.toBeNull(); // B's outcome stands
    expect(after.attempts).toBe(0); // A's retry was not written
    const lost = sink.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === "outbox.lease_lost");
    expect(lost).toEqual([expect.objectContaining({ level: "warn", kind: "k", refId })]);
  });

  test("an enqueue while the handler runs leads to exactly one more run, after it, never at the same time", async () => {
    const { db, outbox, enqueue, row } = await setup();
    const gates = [latch(), latch()];
    const inside = [latch(), latch()];
    let runs = 0;
    let atOnce = 0;
    let maxAtOnce = 0;
    outbox.handle("k", async () => {
      const n = runs++;
      atOnce++;
      maxAtOnce = Math.max(maxAtOnce, atOnce);
      inside[n]?.open();
      await gates[n]?.promise;
      atOnce--;
      return "done";
    });
    await enqueue();
    const first = outbox.runDue();
    await within3s(inside[0]?.promise as Promise<void>, "first run");
    await enqueue(); // a new request for the same job, while it runs
    expect(await outbox.runDue()).toBe(0); // the live claim keeps everybody else out
    expect(runs).toBe(1);
    expect((await row()).rerun).toBe(true);
    gates[0]?.open();
    // The first runDue loops until nothing is due, so it runs the second round itself.
    await within3s(inside[1]?.promise as Promise<void>, "second run");
    gates[1]?.open();
    expect(await first).toBe(2);
    expect(runs).toBe(2);
    expect(maxAtOnce).toBe(1);
    const after = await row();
    expect(after.done_at).not.toBeNull();
    expect(after.rerun).toBe(false);
    expect(await outbox.runDue()).toBe(0);
    expect(db).toBeDefined();
  });

  test("claimOne and finish: a request runs its own job under the same lease", async () => {
    const { outbox, enqueue, row } = await setup();
    await enqueue();
    const mine = await outbox.claimOne("k", (await row()).ref_id);
    expect(mine).not.toBeNull();
    expect(await outbox.claimOne("k", (await row()).ref_id)).toBeNull(); // held
    expect(await outbox.runDue()).toBe(0);
    expect(await outbox.finish(mine as NonNullable<typeof mine>, "done")).toBe(true);
    expect((await row()).done_at).not.toBeNull();
    expect((await row()).claim_token).toBeNull();
  });

  test("three workers on one database: every job runs once and the workers overlap in time", async () => {
    const { db, clock } = await setup();
    const batch = 5;
    const workers = ["w1", "w2", "w3"].map((name) => ({
      name,
      outbox: new Outbox(db, clock, undefined, { batch }),
    }));
    const ranBy = new Map<string, string[]>(); // refId -> which workers ran it
    const gate = latch();
    let atOnce = 0;
    let maxAtOnce = 0;
    for (const w of workers) {
      w.outbox.handle("k", async (job) => {
        ranBy.set(job.refId, [...(ranBy.get(job.refId) ?? []), w.name]);
        atOnce++;
        maxAtOnce = Math.max(maxAtOnce, atOnce);
        // More handlers running than one worker's batch can hold: the workers must be running together.
        if (atOnce > batch) gate.open();
        await gate.promise;
        atOnce--;
        return "done";
      });
    }
    for (let i = 0; i < 30; i++) {
      await transaction(
        db,
        (tx) =>
          workers[0]?.outbox.enqueue(tx, { tenantId: "t1", kind: "k", refId: randomUUID() }) as Promise<void>,
      );
    }
    const runs = Promise.all(workers.map((w) => w.outbox.runDue()));
    try {
      await within3s(gate.promise, "more than one batch running at once");
    } finally {
      gate.open();
    }
    const counts = await runs;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(30);
    expect(ranBy.size).toBe(30);
    for (const by of ranBy.values()) expect(by).toHaveLength(1); // each job ran exactly once
    expect(new Set([...ranBy.values()].flat()).size).toBeGreaterThanOrEqual(2);
    expect(maxAtOnce).toBeGreaterThan(batch);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM outbox WHERE done_at IS NOT NULL");
    expect(rows[0].n).toBe(30);
  });

  test("the claim query can use the outbox_due index", async () => {
    const { db, clock } = await setup();
    // The planner picks by table size, so the sequential scan is switched off for this check.
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SET LOCAL enable_seqscan = off");
      const { rows } = await tx.query(
        `EXPLAIN SELECT id FROM outbox WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= $1
           AND (claimed_until IS NULL OR claimed_until <= $1)
         ORDER BY run_at, id LIMIT 16 FOR UPDATE SKIP LOCKED`,
        [clock.now()],
      );
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("outbox_due");
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });
});
