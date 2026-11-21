import type pg from "pg";
import { currentRequestId } from "../logging/log.ts";

/**
 * The only write path to the audited tables. Every function takes a client that is already inside
 * a transaction (see `transaction()` in src/db.ts), so the change and its audit row commit together.
 * Rows go in and out in snake_case, exactly as in src/schema.sql.
 */

export type Row = Record<string, unknown>;
export type AuditContext = {
  tenantId: string | null;
  actor: string; // "platform/<tenantId>", "player/<our player uuid>", "system/<name>", "admin/<user id>", "unknown"
  requestId?: string; // when missing, the id of the running request or job is used (see write)
  now: Date; // the caller passes clock.now()
};

// The names are put into SQL text, so this list is also the guard against injection.
const TABLES = new Set([
  "players",
  "inbound_events",
  "spins",
  "redemptions",
  "store_items",
  "wheel_configs",
  "grant_policies",
  "ops_policies",
  "tenants",
  "admin_users",
  "settings_changes",
]);
const COLUMN = /^[a-z_][a-z0-9_]*$/;
const SECRET_FIELDS = new Set([
  "webhook_secret",
  "webhook_secret_prev",
  "token_secret",
  "token_secret_prev",
  "wheel_secret",
  "platform_key",
]);

function checkTable(table: string): void {
  if (!TABLES.has(table)) throw new Error(`table ${table} is not audited`);
}

function checkColumns(row: Row): string[] {
  const columns = Object.keys(row);
  for (const c of columns) if (!COLUMN.test(c)) throw new Error(`bad column name ${c}`);
  return columns;
}

// jsonb arrays must be sent as JSON text; pg would turn a JS array into a PostgreSQL array.
const param = (v: unknown): unknown => (Array.isArray(v) ? JSON.stringify(v) : v);

// Values are compared by a string form, so jsonb, bigint-as-string and Date compare sensibly.
function same(a: unknown, b: unknown): boolean {
  const form = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  return form(a) === form(b);
}

function shown(table: string, field: string, value: unknown): unknown {
  if (table === "tenants" && SECRET_FIELDS.has(field))
    return value === null || value === undefined ? null : "***";
  if (table === "admin_users" && field === "password_hash") return "***";
  return value;
}

async function write(
  tx: pg.PoolClient,
  ctx: AuditContext,
  action: string,
  entityType: string,
  entityId: string,
  changes: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, changes, request_id, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ctx.tenantId,
      ctx.actor,
      action,
      entityType,
      entityId,
      JSON.stringify(changes ?? []),
      ctx.requestId ?? currentRequestId() ?? null,
      ctx.now,
    ],
  );
}

/** With `onConflict: "nothing"` a row that already exists gives null and no audit row (this is event dedup). */
export async function create(
  tx: pg.PoolClient,
  ctx: AuditContext,
  table: string,
  row: Row,
  options: { onConflict?: "nothing" } = {},
): Promise<Row | null> {
  checkTable(table);
  const columns = checkColumns(row);
  const marks = columns.map((_, i) => `$${i + 1}`).join(", ");
  const conflict = options.onConflict === "nothing" ? " ON CONFLICT DO NOTHING" : "";
  const result = await tx.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${marks})${conflict} RETURNING *`,
    columns.map((c) => param(row[c])),
  );
  const created = result.rows[0] as Row | undefined;
  if (!created) return null;
  const changes = Object.keys(created).map((field) => ({
    field,
    from: null,
    to: shown(table, field, created[field]),
  }));
  await write(tx, ctx, "create", table, String(created.id), changes);
  return created;
}

/**
 * Locks the row, asks `change` what to set, writes only fields that differ. Returns null (and
 * writes nothing) when the row is missing or nothing differs. The state check done inside `change`
 * runs under the row lock, so this is also the guard against two callers racing.
 */
export async function update(
  tx: pg.PoolClient,
  ctx: AuditContext,
  table: string,
  id: string,
  change: (current: Row) => Partial<Row> | null,
): Promise<{ before: Row; after: Row } | null> {
  checkTable(table);
  const found = await tx.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const before = found.rows[0] as Row | undefined;
  if (!before) return null;
  const wanted = change(before);
  if (!wanted) return null;
  const columns = checkColumns(wanted).filter((c) => !same(before[c], wanted[c]));
  if (columns.length === 0) return null;
  const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const result = await tx.query(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`, [
    id,
    ...columns.map((c) => param(wanted[c])),
  ]);
  const after = result.rows[0] as Row;
  const changes = columns.map((field) => ({
    field,
    from: shown(table, field, before[field]),
    to: shown(table, field, after[field]),
  }));
  await write(tx, ctx, "update", table, String(id), changes);
  return { before, after };
}

export async function remove(tx: pg.PoolClient, ctx: AuditContext, table: string, id: string): Promise<void> {
  checkTable(table);
  const found = await tx.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const old = found.rows[0] as Row | undefined;
  if (!old) return;
  await tx.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  const changes = Object.keys(old).map((field) => ({
    field,
    from: shown(table, field, old[field]),
    to: null,
  }));
  await write(tx, ctx, "delete", table, String(id), changes);
}

/** A fact that is not a row change: a rejected webhook, an outgoing call and its answer. */
export async function record(
  tx: pg.PoolClient,
  ctx: AuditContext,
  fact: { action: string; entityType: string; entityId: string; changes?: unknown },
): Promise<void> {
  await write(tx, ctx, fact.action, fact.entityType, fact.entityId, fact.changes);
}
