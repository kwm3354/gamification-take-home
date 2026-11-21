import type { Db } from "../db.ts";
import { oneOf, pageOf, parseTimeCursor, timeCursor, tsText, uuidParam } from "./paging.ts";

const STATUSES = ["available", "used"] as const;

export interface SpinItem {
  id: string;
  playerId: string;
  playerExternalId: string;
  status: string;
  coins: string | null;
  segmentIndex: number | null;
  createdAt: string;
  usedAt: string | null;
  creditedAt: string | null;
  wheelVersion: number;
  cursor: string;
}

const COLUMNS = `s.id, s.player_id, p.external_id, s.status, s.coins, s.segment_index, s.created_at, s.used_at,
  s.credited_at, w.version AS wheel_version, g.version AS grant_version, ${tsText("s.created_at")} AS cts`;
const FROM = `FROM spins s JOIN players p ON p.id = s.player_id JOIN wheel_configs w ON w.id = s.wheel_config_id
  LEFT JOIN grant_policies g ON g.id = s.grant_policy_id`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

// biome-ignore lint/suspicious/noExplicitAny: a pg row
export function spinItem(r: any): SpinItem {
  return {
    id: r.id,
    playerId: r.player_id,
    playerExternalId: r.external_id,
    status: r.status,
    coins: r.coins === null ? null : String(r.coins),
    segmentIndex: r.segment_index,
    createdAt: new Date(r.created_at).toISOString(),
    usedAt: iso(r.used_at),
    creditedAt: iso(r.credited_at),
    wheelVersion: r.wheel_version,
    cursor: timeCursor(r.cts, r.id),
  };
}

export async function listSpins(
  db: Pick<Db, "query">,
  tenantId: string,
  query: { status?: unknown; playerId?: unknown; before?: unknown },
  limit: number,
) {
  const status = oneOf(query.status, STATUSES, "status");
  const playerId = uuidParam(query.playerId, "playerId");
  const after = parseTimeCursor(query.before);
  const params: unknown[] = [tenantId];
  const where = ["s.tenant_id = $1"];
  if (status) where.push(`s.status = $${params.push(status)}`);
  if (playerId) where.push(`s.player_id = $${params.push(playerId)}`);
  if (after)
    where.push(
      `(s.created_at, s.id) < ($${params.push(after.ts)}::timestamptz, $${params.push(after.id)}::uuid)`,
    );
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")}
      ORDER BY s.created_at DESC, s.id DESC LIMIT $${params.length}`,
    params,
  );
  return pageOf(rows.map(spinItem), limit);
}

/** The spins of one player for the player page: the list item plus the policy version. */
export async function spinsOfPlayer(
  db: Pick<Db, "query">,
  tenantId: string,
  playerId: string,
  limit: number,
) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE s.tenant_id = $1 AND s.player_id = $2
      ORDER BY s.created_at DESC, s.id DESC LIMIT $3`,
    [tenantId, playerId, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as string,
    coins: r.coins === null ? null : String(r.coins),
    createdAt: new Date(r.created_at).toISOString(),
    usedAt: iso(r.used_at),
    creditedAt: iso(r.credited_at),
    wheelVersion: r.wheel_version as number,
    grantPolicyVersion: (r.grant_version as number | null) ?? null,
  }));
}
