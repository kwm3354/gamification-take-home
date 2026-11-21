import type pg from "pg";
import { type AuditContext, create } from "../audit/audited.ts";
import type { PlatformEvent } from "../domain/casino-platform.ts";
import { findOrCreatePlayer } from "../tenants/players.ts";

/**
 * Stores one event and, for a succeeded deposit, gives the player one spin. Runs inside the
 * caller's transaction. The unique key (tenant, external event id) is the dedup: a repeat inserts
 * nothing and so grants nothing.
 */
export async function ingestEvent(
  tx: pg.PoolClient,
  ctx: AuditContext,
  tenantId: string,
  event: PlatformEvent,
  raw: unknown,
): Promise<"accepted" | "ignored" | "duplicate"> {
  let playerId: string | null = null;
  if (event.kind === "deposit_succeeded") {
    playerId = (await findOrCreatePlayer(tx, ctx, tenantId, event.externalPlayerId)).id;
  }
  const stored = await create(
    tx,
    ctx,
    "inbound_events",
    {
      tenant_id: tenantId,
      external_event_id: event.externalEventId,
      kind: event.kind,
      player_id: playerId,
      normalized: event,
      raw,
      received_at: ctx.now,
    },
    { onConflict: "nothing" },
  );
  if (!stored) return "duplicate";
  if (event.kind === "ignored" || playerId === null) return "ignored";

  const wheel = await tx.query(
    "SELECT id FROM wheel_configs WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
    [tenantId],
  );
  if (!wheel.rows[0]) throw new Error(`tenant ${tenantId} has no wheel config`);
  await create(tx, ctx, "spins", {
    tenant_id: tenantId,
    player_id: playerId,
    source_event_id: stored.id,
    wheel_config_id: wheel.rows[0].id,
  });
  return "accepted";
}
