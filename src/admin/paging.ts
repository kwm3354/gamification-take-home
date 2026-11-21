/**
 * Paging for the back office lists. Plain code.
 *
 * A list is newest first. The cursor of a row is an opaque string: base64url of the sort key of
 * that row. `before=<cursor>` gives the rows after that row in the list. Two kinds of key:
 *  - time and uuid: `[<timestamp text with microseconds>, <uuid>]`, sorted by (time, id) descending;
 *  - a bigserial id, sorted descending.
 * The timestamp is carried as text from PostgreSQL, because a JavaScript Date keeps only
 * milliseconds and a cut cursor would skip or repeat rows.
 */

/** A bad query value. The controller turns it into 400. */
export class BadQuery extends Error {}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** SQL text for a timestamptz column, with microseconds. Use it in SELECT for the cursor. */
export const tsText = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function parseLimit(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_LIMIT;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new BadQuery("limit must be an integer 1..100");
  return n;
}

export function timeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id])).toString("base64url");
}

export function parseTimeCursor(value: unknown): { ts: string; id: string } | null {
  if (value === undefined || value === "") return null;
  try {
    const v = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && TS.test(String(v[0])) && isUuid(v[1])) {
      return { ts: String(v[0]), id: String(v[1]) };
    }
  } catch {
    // falls through to the error below
  }
  throw new BadQuery("before is not a cursor of this list");
}

export const idCursor = (id: number | string): string => Buffer.from(String(id)).toString("base64url");

export function parseIdCursor(value: unknown): number | null {
  if (value === undefined || value === "") return null;
  const text = Buffer.from(String(value), "base64url").toString("utf8");
  if (!/^\d{1,15}$/.test(text)) throw new BadQuery("before is not a cursor of this list");
  return Number(text);
}

/** Cuts the extra row that was fetched to learn whether there is a next page. */
export function pageOf<T extends { cursor: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.cursor : null };
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new BadQuery(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function uuidParam(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isUuid(value)) throw new BadQuery(`${name} must be an id`);
  return value;
}
