import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { context, createContextKey } from "@opentelemetry/api";
import pg from "pg";
import { span, tracingOn } from "./tracing/tracing.ts";

export type Db = pg.Pool;

export function connect(url: string, max = 5): Db {
  return traced(new pg.Pool({ connectionString: url, max }));
}

// ---- tracing -------------------------------------------------------------------------------
// Every query is a span `db <KEYWORD> <table>` and getting a client is `db acquire`. It is done here,
// in one place, so no caller changes. The statement attribute is the SQL text only: parameter values
// are never passed to the span. With tracing off the wrapped functions call straight through.

const IN_POOL_QUERY = createContextKey("db.in_pool_query");
const TABLE = /(?:\bfrom|\binto|^\s*update)\s+"?([a-z_][a-z0-9_.]*)"?/i;

/** The SQL text of a query call, or undefined for forms we do not trace (callbacks, submittables). */
function sqlOf(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof args[args.length - 1] === "function") return undefined;
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null && typeof (first as { text?: unknown }).text === "string") {
    return (first as { text: string }).text;
  }
  return undefined;
}

function tracedQuery<A extends unknown[], R>(original: (...args: A) => R, self: object): (...args: A) => R {
  return (...args: A): R => {
    const sql = tracingOn() && context.active().getValue(IN_POOL_QUERY) !== true ? sqlOf(args) : undefined;
    if (sql === undefined) return original.apply(self, args);
    const flat = sql.replace(/\s+/g, " ").trim();
    const keyword = (/^\(?\s*([a-z]+)/i.exec(flat)?.[1] ?? "query").toUpperCase();
    const table = TABLE.exec(flat)?.[1];
    return span(
      `db ${keyword}${table ? ` ${table}` : ""}`,
      { "db.system": "postgresql", "db.operation.name": keyword, "db.statement": flat.slice(0, 200) },
      () => original.apply(self, args),
    );
  };
}

const WRAPPED = Symbol("traced");

function traced(pool: pg.Pool): pg.Pool {
  const poolQuery = tracedQuery(pool.query.bind(pool) as (...a: unknown[]) => unknown, pool);
  const connectOriginal = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
  // pg-pool's own query() takes a client through connect(); the mark keeps that client's query from a second span.
  pool.query = ((...args: unknown[]) =>
    tracingOn()
      ? context.with(context.active().setValue(IN_POOL_QUERY, true), () => poolQuery(...args))
      : poolQuery(...args)) as typeof pool.query;
  // Only the promise form of connect() is traced; the callback form goes straight through.
  // Clients are wrapped even while tracing is off: they live long and tracing may start later.
  const checkout = async (): Promise<pg.PoolClient> => {
    const client = (await connectOriginal()) as pg.PoolClient & { [WRAPPED]?: true };
    if (!client[WRAPPED]) {
      client[WRAPPED] = true;
      client.query = tracedQuery(
        client.query.bind(client) as (...a: unknown[]) => unknown,
        client,
      ) as typeof client.query;
    }
    return client;
  };
  pool.connect = ((...args: unknown[]) => {
    if (args.length > 0) return connectOriginal(...args);
    return tracingOn() ? span("db acquire", {}, checkout) : checkout();
  }) as typeof pool.connect;
  return pool;
}

/** Any fixed number; every process that applies the schema uses the same one. */
const MIGRATE_LOCK_KEY = 7_340_011;

/**
 * Applies the schema. The file is safe to run twice, but two processes running it at the same
 * moment can collide on CREATE TABLE. So it runs under an advisory lock, taken and released on one
 * connection: the second process waits, then finds everything in place.
 *
 * The script is run only when its text has changed since the last run (its hash is kept in
 * `schema_state`). Running it takes exclusive table locks even when nothing changes, and a process
 * that starts while others work deadlocked with their transactions (found by test/processes.test.ts).
 * A deployment that changes the schema still takes those locks once.
 */
export async function migrate(db: Db): Promise<void> {
  const sql = await readFile(new URL("schema.sql", import.meta.url), "utf8");
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    try {
      const hash = createHash("sha256").update(sql).digest("hex");
      await client.query("CREATE TABLE IF NOT EXISTS schema_state (id int PRIMARY KEY, hash text NOT NULL)");
      const seen = await client.query("SELECT hash FROM schema_state WHERE id = 1");
      if (seen.rows[0]?.hash !== hash) {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_state (id, hash) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash",
          [hash],
        );
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
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
