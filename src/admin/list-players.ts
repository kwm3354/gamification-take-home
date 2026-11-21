import type { Db } from "../db.ts";
import type { CoinLedger } from "../domain/coin-ledger.ts";
import { LedgerUnavailable } from "../domain/coin-ledger.ts";
import { eventsOfPlayer } from "./list-events.ts";
import { redemptionsOfPlayer } from "./list-redemptions.ts";
import { spinsOfPlayer } from "./list-spins.ts";
import { BadQuery, isUuid, pageOf, parseTimeCursor, timeCursor, tsText } from "./paging.ts";

export interface PlayerItem {
  id: string;
  externalId: string;
  createdAt: string;
  spinsAvailable: number;
  spinsUsed: number;
  redemptions: number;
  cursor: string;
}

export async function listPlayers(
  db: Pick<Db, "query">,
  tenantId: string,
  query: { q?: unknown; before?: unknown },
  limit: number,
) {
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 100)) {
    throw new BadQuery("q must be text of at most 100 characters");
  }
  const after = parseTimeCursor(query.before);
  const params: unknown[] = [tenantId];
  const where = ["p.tenant_id = $1"];
  // starts_with: no wildcard characters to escape.
  if (query.q) where.push(`starts_with(p.external_id, $${params.push(query.q)})`);
  if (after)
    where.push(
      `(p.created_at, p.id) < ($${params.push(after.ts)}::timestamptz, $${params.push(after.id)}::uuid)`,
    );
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT p.id, p.external_id, p.created_at, ${tsText("p.created_at")} AS cts,
            (SELECT count(*) FROM spins s WHERE s.tenant_id = p.tenant_id AND s.player_id = p.id AND s.status = 'available')::int AS spins_available,
            (SELECT count(*) FROM spins s WHERE s.tenant_id = p.tenant_id AND s.player_id = p.id AND s.status = 'used')::int AS spins_used,
            (SELECT count(*) FROM redemptions r WHERE r.tenant_id = p.tenant_id AND r.player_id = p.id)::int AS redemptions
       FROM players p WHERE ${where.join(" AND ")}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
    params,
  );
  const items: PlayerItem[] = rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    createdAt: new Date(r.created_at).toISOString(),
    spinsAvailable: r.spins_available,
    spinsUsed: r.spins_used,
    redemptions: r.redemptions,
    cursor: timeCursor(r.cts, r.id),
  }));
  return pageOf(items, limit);
}

/** The balance of a player, or null when the ledger does not answer. */
export async function balanceOrNull(coins: CoinLedger, ledgerNo: number, playerId: string) {
  try {
    const b = await coins.balance({ ledgerNo, playerId });
    return { available: String(b.available), reserved: String(b.reserved) };
  } catch (e) {
    if (!(e instanceof LedgerUnavailable)) throw e;
    return null;
  }
}

export async function playerDetail(
  db: Pick<Db, "query">,
  coins: CoinLedger,
  tenant: { id: string; ledgerNo: number },
  id: string,
) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    "SELECT id, external_id, created_at FROM players WHERE tenant_id = $1 AND id = $2",
    [tenant.id, id],
  );
  const p = rows[0];
  if (!p) return null;
  return {
    player: { id: p.id, externalId: p.external_id, createdAt: new Date(p.created_at).toISOString() },
    balance: await balanceOrNull(coins, tenant.ledgerNo, id),
    spins: await spinsOfPlayer(db, tenant.id, id, 50),
    redemptions: await redemptionsOfPlayer(db, tenant.id, id, 50),
    events: await eventsOfPlayer(db, tenant.id, id, 50),
  };
}
