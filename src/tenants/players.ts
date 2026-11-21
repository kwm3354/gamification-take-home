import { randomUUID } from "node:crypto";
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
 * `actorOf` names the audit actor once the new player's id is known: the id is made here, before
 * the insert, so a player can be the actor of the row that creates it.
 */
export async function findOrCreatePlayer(
  tx: pg.PoolClient,
  ctx: AuditContext,
  tenantId: string,
  externalId: string,
  actorOf?: (playerId: string) => string,
): Promise<Player> {
  const find = () =>
    tx.query<PlayerRow>("SELECT * FROM players WHERE tenant_id = $1 AND external_id = $2", [
      tenantId,
      externalId,
    ]);
  const found = await find();
  if (found.rows[0]) return toPlayer(found.rows[0]);
  const id = randomUUID();
  const created = await create(
    tx,
    actorOf ? { ...ctx, actor: actorOf(id) } : ctx,
    "players",
    { id, tenant_id: tenantId, external_id: externalId },
    { onConflict: "nothing" },
  );
  if (created) return toPlayer(created as PlayerRow);
  const again = await find();
  return toPlayer(again.rows[0] as PlayerRow);
}
