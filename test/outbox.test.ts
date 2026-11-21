import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { FakeClock } from "../src/clock.ts";
import { transaction } from "../src/db.ts";
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
    await handlerStarted; // the first run holds the row lock now
    // If the second run waits for the lock instead of skipping it, this watchdog frees the first run
    // so the test can fail instead of hanging. It does not fire when the claim skips locked rows.
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

  test("the claim query can use the outbox_due index", async () => {
    const { db, clock } = await setup();
    // The planner picks by table size, so the sequential scan is switched off for this check.
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SET LOCAL enable_seqscan = off");
      const { rows } = await tx.query(
        `EXPLAIN SELECT id FROM outbox WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= $1
         ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
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
