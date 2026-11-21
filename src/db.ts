import { readFile } from "node:fs/promises";
import pg from "pg";

export type Db = pg.Pool;

export function connect(url: string, max = 5): Db {
  return new pg.Pool({ connectionString: url, max });
}

export async function migrate(db: Db): Promise<void> {
  await db.query(await readFile(new URL("schema.sql", import.meta.url), "utf8"));
}

export async function transaction<T>(db: Db, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
