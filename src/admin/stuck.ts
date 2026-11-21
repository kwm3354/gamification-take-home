import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";

export interface StuckItem {
  id: string;
  status: string;
  settled: boolean;
  playerExternalId: string;
  costCoins: string;
  ageSec: number;
  platformRef: string | null;
  /** The `changes` of the newest "platform_call" audit row of this redemption, or null. */
  lastPlatformCall: unknown;
}

/**
 * Redemptions of the tenant that are not final for the player (created, reserved, submitting) or
 * final but not settled, and were created more than `limitSec` ago. Oldest first. Age counts from
 * `created_at`: a record that keeps being retried is still stuck.
 */
export async function stuckRedemptions(
  db: Pick<Db, "query">,
  clock: Clock,
  tenantId: string,
  limitSec: number,
): Promise<StuckItem[]> {
  const now = clock.now();
  const cutoff = new Date(now.getTime() - limitSec * 1000);
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.settled_at, r.cost_coins, r.platform_ref, r.created_at, p.external_id,
            (SELECT a.changes FROM audit_log a
              WHERE a.entity_type = 'redemption' AND a.entity_id = r.id::text AND a.action = 'platform_call'
              ORDER BY a.id DESC LIMIT 1) AS last_call
       FROM redemptions r JOIN players p ON p.id = r.player_id
      WHERE r.tenant_id = $1
        AND r.created_at < $2
        AND (r.status IN ('created', 'reserved', 'submitting')
             OR (r.status IN ('issued', 'refused') AND r.settled_at IS NULL))
      ORDER BY r.created_at, r.id`,
    [tenantId, cutoff],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    settled: r.settled_at !== null,
    playerExternalId: r.external_id,
    costCoins: String(r.cost_coins),
    ageSec: Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 1000),
    platformRef: r.platform_ref,
    lastPlatformCall: r.last_call ?? null,
  }));
}
