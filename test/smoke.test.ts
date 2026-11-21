import { afterAll, beforeAll, expect, test } from "vitest";
import type { Db } from "../src/db.ts";
import { freshDb } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await freshDb());
});
afterAll(() => close());

// Proves the toolchain works: PostgreSQL starts, the schema loads, a query runs.
// Delete this file once the first real test exists.
test("the database is reachable and migrated", async () => {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM smoke");
  expect(rows[0].n).toBe(0);
});
