import { describe, expect, test } from "vitest";
import { migrate } from "../src/db.ts";
import { freshDb } from "./harness.ts";

/**
 * Found by test/processes.test.ts: a process that started while others were working took locks with
 * the schema script (ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes an exclusive table lock even when
 * the column is there) and deadlocked with live requests. The new process died and a request got a 500.
 * A schema that is already applied must take no table lock.
 */
describe("migrate under load", () => {
  test("a schema that is already applied does not wait for a transaction that has written to the tables", async () => {
    const { db, close } = await freshDb();
    const writer = await db.connect();
    let blocked: Promise<void> | undefined;
    try {
      await writer.query("BEGIN");
      // What an INSERT into these tables holds until its transaction ends.
      await writer.query("LOCK TABLE outbox, redemptions, spins IN ROW EXCLUSIVE MODE");
      blocked = migrate(db);
      const outcome = await Promise.race([
        blocked.then(() => "done"),
        new Promise((r) => setTimeout(() => r("waiting"), 3000)),
      ]);
      expect(outcome, "migrate waited for a lock held by a running transaction").toBe("done");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await blocked?.catch(() => undefined); // before the fix it finishes now
      await close();
    }
  }, 20_000);
});
