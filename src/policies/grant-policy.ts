import type { DepositSucceeded } from "../domain/casino-platform.ts";

/**
 * How to add a condition to the grant rule:
 * 1. Add a field to GrantParams and to validateGrantParams (with a hard limit).
 * 2. Add one check to spinsForDeposit, before the final return.
 * 3. Add a row to the table in test/grant-policy.test.ts.
 */
export interface GrantParams {
  /** A deposit below this many minor units gives nothing. */
  minAmountMinor: number;
  /** Allowed currency codes; null means any. */
  currencies: string[] | null;
  /** How many spins a qualifying deposit gives. */
  spinsPerDeposit: number;
}

export const MAX_SPINS_PER_DEPOSIT = 10;

export type GrantDecision = { spins: number } | { spins: 0; reason: string };

/** The decision point. A pure function: the deposit and the tenant's params in, a number of spins out. */
export function spinsForDeposit(deposit: DepositSucceeded, params: GrantParams): GrantDecision {
  if (deposit.amountMinor < params.minAmountMinor) return { spins: 0, reason: "below_minimum" };
  if (params.currencies && !params.currencies.includes(deposit.currency)) {
    return { spins: 0, reason: "currency_not_allowed" };
  }
  if (params.spinsPerDeposit === 0) return { spins: 0, reason: "zero_spins" };
  return { spins: params.spinsPerDeposit };
}

/** Hard limits on the params. Returns the params as a typed value, or throws with the reason. */
export function validateGrantParams(value: unknown): GrantParams {
  if (typeof value !== "object" || value === null) throw new Error("params must be an object");
  const v = value as Record<string, unknown>;
  const { minAmountMinor, currencies, spinsPerDeposit } = v;
  if (typeof minAmountMinor !== "number" || !Number.isInteger(minAmountMinor) || minAmountMinor < 0) {
    throw new Error("minAmountMinor must be an integer >= 0");
  }
  if (
    typeof spinsPerDeposit !== "number" ||
    !Number.isInteger(spinsPerDeposit) ||
    spinsPerDeposit < 0 ||
    spinsPerDeposit > MAX_SPINS_PER_DEPOSIT
  ) {
    throw new Error(`spinsPerDeposit must be an integer 0..${MAX_SPINS_PER_DEPOSIT}`);
  }
  if (currencies !== null) {
    const ok =
      Array.isArray(currencies) &&
      currencies.length > 0 &&
      currencies.every((c) => typeof c === "string" && /^[A-Z]{3}$/.test(c));
    if (!ok) throw new Error("currencies must be null or a non-empty list of 3-letter codes");
  }
  return { minAmountMinor, currencies: currencies as string[] | null, spinsPerDeposit };
}
