import type pg from "pg";
import { type AuditContext, create } from "../audit/audited.ts";

export interface Player {
  id: string;
  tenantId: string;
  externalId: string;
}

type PlayerRow = { id: string; tenant_id: string; external_id: string };

const toPlayer = (r: PlayerRow): Player => ({ id: r.id, tenantId: r.tenant_id, externalId: r.external_id });

/**
 * Our player for the platform's player id. Two callers racing on a new player both get the same
 * row: the insert does nothing for the loser, and the select then finds the winner's row.
 */
export async function findOrCreatePlayer(
  tx: pg.PoolClient,
  ctx: AuditContext,
  tenantId: string,
  externalId: string,
): Promise<Player> {
  const find = () =>
    tx.query<PlayerRow>("SELECT * FROM players WHERE tenant_id = $1 AND external_id = $2", [
      tenantId,
      externalId,
    ]);
  const found = await find();
  if (found.rows[0]) return toPlayer(found.rows[0]);
  const created = await create(
    tx,
    ctx,
    "players",
    { tenant_id: tenantId, external_id: externalId },
    { onConflict: "nothing" },
  );
  if (created) return toPlayer(created as PlayerRow);
  const again = await find();
  return toPlayer(again.rows[0] as PlayerRow);
}
