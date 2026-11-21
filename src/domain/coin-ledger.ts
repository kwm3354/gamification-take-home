/**
 * Port: the coin ledger, in the domain's words. The implementation is TigerBeetle (src/ledger).
 *
 * Every call is safe to repeat: transfer ids are derived from the spin or redemption id, so a
 * second call with the same id moves nothing. A call that cannot reach the ledger in time throws
 * LedgerUnavailable; the caller retries later with the same ids.
 */
export interface CoinLedger {
  /** Credits the prize of a spin: issuer account of the tenant -> player. */
  creditPrize(input: { ledgerNo: number; playerId: string; spinId: string; coins: bigint }): Promise<void>;

  /**
   * Reserves the price of a redemption (a pending transfer: player -> the tenant's issuer account,
   * so spent coins come back to where they came from).
   * "insufficient" is final for this redemption id: the ledger refuses a balance below zero by itself.
   */
  reserve(input: {
    ledgerNo: number;
    playerId: string;
    redemptionId: string;
    coins: bigint;
  }): Promise<"reserved" | "insufficient">;

  /** The reward was issued: the reserve becomes a real debit. */
  capture(input: { ledgerNo: number; redemptionId: string }): Promise<void>;

  /** The reward was refused: the reserve is dropped and the coins are available again. */
  release(input: { ledgerNo: number; redemptionId: string }): Promise<void>;

  /** `available` can be spent now; `reserved` is held by redemptions that are not final yet. */
  balance(input: { ledgerNo: number; playerId: string }): Promise<{ available: bigint; reserved: bigint }>;

  /**
   * All coins the tenant has issued and players have not spent: the balance of ONE account, the
   * issuer (posted debits minus posted credits). A pending reserve has not come back yet, so it
   * does not lower this number until capture.
   */
  outstanding(input: { ledgerNo: number }): Promise<bigint>;
}

export class LedgerUnavailable extends Error {}

/** Injection token: `@Inject(COIN_LEDGER) private readonly coins: CoinLedger`. */
export const COIN_LEDGER = Symbol("COIN_LEDGER");
