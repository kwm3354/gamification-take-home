import type pg from "pg";
import { type AuditContext, create, record } from "../audit/audited.ts";
import type { PlatformEvent } from "../domain/casino-platform.ts";
import { spinsForDeposit, validateGrantParams } from "../policies/grant-policy.ts";
import { findOrCreatePlayer } from "../tenants/players.ts";

/** What happened to one event. The caller logs it after the transaction has committed. */
export type IngestOutcome =
  | { outcome: "accepted"; spinsGranted: number }
  | { outcome: "ignored"; why: string }
  | { outcome: "duplicate" };

/**
 * Stores one event and, for a succeeded deposit, gives the player as many spins as the tenant's
 * newest grant policy says (possibly none; then an audit record says why). Runs inside the
 * caller's transaction. The unique key (tenant, external event id) is the dedup: a repeat inserts
 * nothing and so grants nothing.
 */
export async function ingestEvent(
  tx: pg.PoolClient,
  ctx: AuditContext,
  tenantId: string,
  event: PlatformEvent,
  raw: unknown,
): Promise<IngestOutcome> {
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
  if (!stored) return { outcome: "duplicate" };
  if (event.kind === "ignored") return { outcome: "ignored", why: event.why };
  if (playerId === null) return { outcome: "ignored", why: "no_player" };

  const wheel = await tx.query(
    "SELECT id FROM wheel_configs WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
    [tenantId],
  );
  if (!wheel.rows[0]) throw new Error(`tenant ${tenantId} has no wheel config`);
  const policy = await tx.query(
    "SELECT id, params FROM grant_policies WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
    [tenantId],
  );
  if (!policy.rows[0]) throw new Error(`tenant ${tenantId} has no grant policy`);
  const grantPolicyId = policy.rows[0].id as string;

  const decision = spinsForDeposit(event, validateGrantParams(policy.rows[0].params));
  if (decision.spins === 0) {
    await record(tx, ctx, {
      action: "spin_not_granted",
      entityType: "inbound_event",
      entityId: String(stored.id),
      changes: { reason: "reason" in decision ? decision.reason : "zero_spins", grantPolicyId },
    });
    return { outcome: "accepted", spinsGranted: 0 };
  }
  for (let ordinal = 1; ordinal <= decision.spins; ordinal++) {
    await create(tx, ctx, "spins", {
      tenant_id: tenantId,
      player_id: playerId,
      source_event_id: stored.id,
      ordinal,
      wheel_config_id: wheel.rows[0].id,
      grant_policy_id: grantPolicyId,
    });
  }
  return { outcome: "accepted", spinsGranted: decision.spins };
}
