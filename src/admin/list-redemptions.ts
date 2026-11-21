import type { Db } from "../db.ts";
import { JOB_KIND } from "../store/redemption.ts";
import { type AuditEntry, auditTrail } from "./audit-trail.ts";
import { isUuid, oneOf, pageOf, parseTimeCursor, timeCursor, tsText, uuidParam } from "./paging.ts";

const STATUSES = ["created", "reserved", "submitting", "issued", "refused", "insufficient"] as const;

export interface RedemptionItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  playerId: string;
  playerExternalId: string;
  itemCode: string;
  itemName: string;
  costCoins: string;
  status: string;
  settled: boolean;
  platformRef: string | null;
  reason: string | null;
  cursor: string;
}

const COLUMNS = `r.id, r.created_at, r.updated_at, r.player_id, p.external_id, i.code, i.name,
  r.cost_coins, r.status, r.settled_at, r.platform_ref, r.reason, ${tsText("r.created_at")} AS cts`;
const FROM = "FROM redemptions r JOIN players p ON p.id = r.player_id JOIN store_items i ON i.id = r.item_id";

// biome-ignore lint/suspicious/noExplicitAny: a pg row
export function redemptionItem(r: any): RedemptionItem {
  return {
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    playerId: r.player_id,
    playerExternalId: r.external_id,
    itemCode: r.code,
    itemName: r.name,
    costCoins: String(r.cost_coins),
    status: r.status,
    settled: r.settled_at !== null,
    platformRef: r.platform_ref,
    reason: r.reason,
    cursor: timeCursor(r.cts, r.id),
  };
}

export async function listRedemptions(
  db: Pick<Db, "query">,
  tenantId: string,
  query: { status?: unknown; playerId?: unknown; before?: unknown },
  limit: number,
) {
  const status = oneOf(query.status, STATUSES, "status");
  const playerId = uuidParam(query.playerId, "playerId");
  const after = parseTimeCursor(query.before);
  const params: unknown[] = [tenantId];
  const where = ["r.tenant_id = $1"];
  if (status) where.push(`r.status = $${params.push(status)}`);
  if (playerId) where.push(`r.player_id = $${params.push(playerId)}`);
  if (after)
    where.push(
      `(r.created_at, r.id) < ($${params.push(after.ts)}::timestamptz, $${params.push(after.id)}::uuid)`,
    );
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
    params,
  );
  return pageOf(rows.map(redemptionItem), limit);
}

/** The newest `limit` redemptions of one player (for the player page). */
export async function redemptionsOfPlayer(
  db: Pick<Db, "query">,
  tenantId: string,
  playerId: string,
  limit: number,
) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE r.tenant_id = $1 AND r.player_id = $2
      ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
    [tenantId, playerId, limit],
  );
  return rows.map(redemptionItem);
}

export interface RedemptionDetail {
  redemption: RedemptionItem;
  reward: unknown;
  audit: AuditEntry[];
  job: {
    runAt: string;
    attempts: number;
    lastError: string | null;
    doneAt: string | null;
    deadAt: string | null;
  } | null;
}

export async function redemptionDetail(
  db: Pick<Db, "query">,
  tenantId: string,
  id: string,
): Promise<RedemptionDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNS}, r.reward ${FROM} WHERE r.tenant_id = $1 AND r.id = $2`,
    [tenantId, id],
  );
  const row = rows[0];
  if (!row) return null;
  const job = (
    await db.query(
      "SELECT run_at, attempts, last_error, done_at, dead_at FROM outbox WHERE tenant_id = $1 AND kind = $2 AND ref_id = $3",
      [tenantId, JOB_KIND, id],
    )
  ).rows[0];
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    redemption: redemptionItem(row),
    reward: row.reward,
    audit: await auditTrail(db, tenantId, id),
    job: job
      ? {
          runAt: iso(job.run_at) as string,
          attempts: job.attempts,
          lastError: job.last_error,
          doneAt: iso(job.done_at),
          deadAt: iso(job.dead_at),
        }
      : null,
  };
}
