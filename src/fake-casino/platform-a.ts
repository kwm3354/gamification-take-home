import type { DemoTenant } from "../tenants/demo-tenants.ts";
import { type Reply, type World, isoNow } from "./state.ts";

export interface AGrantInput {
  playerId: string;
  amountMinor: number;
  currency: string;
  reference: string;
}

/** Returns an error text, or the checked input. */
export function parseAGrant(body: Record<string, unknown>): AGrantInput | string {
  const { player_id, amount_minor, currency, reference } = body;
  if (typeof player_id !== "string" || !player_id) return "player_id is required";
  if (!Number.isInteger(amount_minor) || (amount_minor as number) <= 0) {
    return "amount_minor must be a positive integer";
  }
  if (typeof currency !== "string" || !currency) return "currency is required";
  if (typeof reference !== "string" || !reference) return "reference is required";
  return { playerId: player_id, amountMinor: amount_minor as number, currency, reference };
}

/** The same Idempotency-Key gives the first answer back and grants nothing new. */
export function aGrant(
  world: World,
  tenant: DemoTenant,
  key: string,
  input: AGrantInput,
  refuse: boolean,
): Reply {
  if (refuse) {
    world.rejected.set(`${tenant.id}|${input.reference}`, "player_blocked");
    return { status: 422, body: { error: "player_blocked" } };
  }
  const stored = world.idempotency.get(`${tenant.id}|${key}`);
  if (stored) return stored;
  const bonusId = world.nextBonusId();
  world.grants.push({
    tenantId: tenant.id,
    platform: "A",
    playerId: input.playerId,
    reference: input.reference,
    amountMinor: input.amountMinor,
    currency: input.currency,
    platformRef: bonusId,
    at: isoNow(),
  });
  const reply: Reply = { status: 201, body: { bonus_id: bonusId, status: "granted" } };
  world.idempotency.set(`${tenant.id}|${key}`, reply);
  return reply;
}

export function aFind(world: World, tenant: DemoTenant, reference: string): Reply {
  const grant = world.grants.find((g) => g.tenantId === tenant.id && g.reference === reference);
  if (grant) return { status: 200, body: { bonus_id: grant.platformRef, status: "granted" } };
  const reason = world.rejected.get(`${tenant.id}|${reference}`);
  if (reason) return { status: 200, body: { status: "rejected", error: reason } };
  return { status: 404, body: { error: "not_found" } };
}
