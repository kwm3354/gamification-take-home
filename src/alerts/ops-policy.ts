import type { Db } from "../db.ts";

/**
 * Alert thresholds of one operator. Versioned like the grant policy: a change is a new row in
 * `ops_policies`, the newest version applies.
 */
export interface OpsParams {
  /** A redemption without a final answer (or not settled) for longer than this is stuck. */
  pendingAgeLimitSec: number;
  /** The wheel's expected prize per spin, in coins, must not be above this. */
  maxExpectedPrizeCoins: number;
  /** More spins granted to one player in 24 hours than this is a warning. */
  maxSpinsPerPlayerPerDay: number;
  /** One player's share of the tenant's issued coins in 24 hours must not be above this. */
  maxPlayerRedeemShare: number;
  /** The share check runs only when the tenant's issued coins in 24 hours reach this. */
  minRedeemedForShare: number;
}

export interface OpsPolicy {
  id: string;
  version: number;
  params: OpsParams;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Hard limits on the params. Returns the params as a typed value, or throws with the reason. */
export function validateOpsParams(value: unknown): OpsParams {
  if (typeof value !== "object" || value === null) throw new Error("params must be an object");
  const v = value as Record<string, unknown>;
  const { pendingAgeLimitSec, maxExpectedPrizeCoins, maxSpinsPerPlayerPerDay } = v;
  const { maxPlayerRedeemShare, minRedeemedForShare } = v;
  if (!isInt(pendingAgeLimitSec, 10, 86_400)) {
    throw new Error("pendingAgeLimitSec must be an integer 10..86400");
  }
  if (!isNumber(maxExpectedPrizeCoins) || maxExpectedPrizeCoins <= 0) {
    throw new Error("maxExpectedPrizeCoins must be a number > 0");
  }
  if (!isInt(maxSpinsPerPlayerPerDay, 1, 1000)) {
    throw new Error("maxSpinsPerPlayerPerDay must be an integer 1..1000");
  }
  if (!isNumber(maxPlayerRedeemShare) || maxPlayerRedeemShare <= 0 || maxPlayerRedeemShare > 1) {
    throw new Error("maxPlayerRedeemShare must be a number in (0, 1]");
  }
  if (!isNumber(minRedeemedForShare) || minRedeemedForShare < 0) {
    throw new Error("minRedeemedForShare must be a number >= 0");
  }
  return {
    pendingAgeLimitSec,
    maxExpectedPrizeCoins,
    maxSpinsPerPlayerPerDay,
    maxPlayerRedeemShare,
    minRedeemedForShare,
  };
}

/** The newest version for the tenant, or null when it has none. */
export async function loadOpsPolicy(db: Pick<Db, "query">, tenantId: string): Promise<OpsPolicy | null> {
  const { rows } = await db.query(
    "SELECT id, version, params FROM ops_policies WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
    [tenantId],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, version: r.version, params: validateOpsParams(r.params) };
}
