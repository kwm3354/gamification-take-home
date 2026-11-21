import { randomUUID } from "node:crypto";
import pg from "pg";
import { type Db, connect, migrate } from "../src/db.ts";

/** A fresh database per test file, inside the PostgreSQL that global-setup started. */
export async function freshDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const base = process.env.TEST_PG_URL;
  if (!base) throw new Error("TEST_PG_URL is not set: global-setup did not run");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = connect(url.toString());
  await migrate(db);
  return { db, close: () => db.end() };
}
