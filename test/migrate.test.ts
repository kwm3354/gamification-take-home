import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { connect, migrate } from "../src/db.ts";

const base = process.env.TEST_PG_URL;
const names: string[] = [];

afterAll(async () => {
  if (!base) return;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

/** An empty database: no tables yet, so two processes starting together both have work to do. */
async function emptyDb(): Promise<string> {
  if (!base) throw new Error("TEST_PG_URL is not set: global-setup did not run");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  names.push(name);
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("migrate", () => {
  test("two processes starting at the same moment on a fresh database both succeed", async () => {
    // A few rounds, because without the lock the collision is a race and does not happen every time.
    for (let round = 0; round < 5; round++) {
      const url = await emptyDb();
      const a = connect(url, 2);
      const b = connect(url, 2);
      try {
        await Promise.all([migrate(a), migrate(b)]);
        const { rows } = await a.query("SELECT to_regclass('outbox') AS t");
        expect(rows[0].t).toBe("outbox");
        await migrate(a); // and again on a database that already has everything
      } finally {
        await a.end();
        await b.end();
      }
    }
  });
});
