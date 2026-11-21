import type { Db } from "../db.ts";
import { isUuid, oneOf, pageOf, parseTimeCursor, timeCursor, tsText } from "./paging.ts";

const KINDS = ["deposit_succeeded", "ignored"] as const;

export interface EventItem {
  id: string;
  externalEventId: string;
  kind: string;
  playerId: string | null;
  playerExternalId: string | null;
  receivedAt: string;
  normalized: unknown;
  cursor: string;
}

const COLUMNS = `e.id, e.external_event_id, e.kind, e.player_id, p.external_id, e.received_at, e.normalized,
  ${tsText("e.received_at")} AS cts`;
const FROM = "FROM inbound_events e LEFT JOIN players p ON p.id = e.player_id";

// biome-ignore lint/suspicious/noExplicitAny: a pg row
export function eventItem(r: any): EventItem {
  return {
    id: r.id,
    externalEventId: r.external_event_id,
    kind: r.kind,
    playerId: r.player_id,
    playerExternalId: r.external_id,
    receivedAt: new Date(r.received_at).toISOString(),
    normalized: r.normalized,
    cursor: timeCursor(r.cts, r.id),
  };
}

export async function listEvents(
  db: Pick<Db, "query">,
  tenantId: string,
  query: { kind?: unknown; before?: unknown },
  limit: number,
) {
  const kind = oneOf(query.kind, KINDS, "kind");
  const after = parseTimeCursor(query.before);
  const params: unknown[] = [tenantId];
  const where = ["e.tenant_id = $1"];
  if (kind) where.push(`e.kind = $${params.push(kind)}`);
  if (after)
    where.push(
      `(e.received_at, e.id) < ($${params.push(after.ts)}::timestamptz, $${params.push(after.id)}::uuid)`,
    );
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")}
      ORDER BY e.received_at DESC, e.id DESC LIMIT $${params.length}`,
    params,
  );
  return pageOf(rows.map(eventItem), limit);
}

export async function eventsOfPlayer(
  db: Pick<Db, "query">,
  tenantId: string,
  playerId: string,
  limit: number,
) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE e.tenant_id = $1 AND e.player_id = $2
      ORDER BY e.received_at DESC, e.id DESC LIMIT $3`,
    [tenantId, playerId, limit],
  );
  return rows.map(eventItem);
}

export async function eventDetail(db: Pick<Db, "query">, tenantId: string, id: string) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(`SELECT ${COLUMNS}, e.raw ${FROM} WHERE e.tenant_id = $1 AND e.id = $2`, [
    tenantId,
    id,
  ]);
  const row = rows[0];
  if (!row) return null;
  const spins = await db.query(
    "SELECT id, status FROM spins WHERE tenant_id = $1 AND source_event_id = $2 ORDER BY ordinal",
    [tenantId, id],
  );
  return {
    ...eventItem(row),
    raw: row.raw,
    spins: spins.rows.map((s) => ({ id: s.id, status: s.status })),
  };
}
