/**
 * Ports to a casino platform, in the domain's words. One adapter per platform implements them
 * (src/integrations). Nothing outside src/integrations knows a platform's field names.
 */

/** What a deposit looks like inside, whatever the platform sent. */
export interface DepositSucceeded {
  kind: "deposit_succeeded";
  externalEventId: string;
  externalPlayerId: string;
  amountMinor: number; // integer, in the smallest unit of the currency
  currency: string;
  occurredAt: string; // ISO 8601
}

/** An event that is valid and signed but does nothing here (a failed deposit, another type). */
export interface IgnoredEvent {
  kind: "ignored";
  externalEventId: string;
  why: string;
}

export type PlatformEvent = DepositSucceeded | IgnoredEvent;

/** The platform's answer about one reward, by reference to our redemption. Sent by webhook on platform B. */
export interface RewardNotice {
  redemptionId: string;
  outcome: RewardOutcome;
}

/**
 * The three things a platform can say about a reward. This is domain language: the status the
 * player sees is built from the same words.
 */
export type RewardOutcome =
  | { kind: "issued"; platformRef: string }
  | { kind: "refused"; reason: string }
  | { kind: "pending"; platformRef?: string }; // accepted but not final, or we do not know yet

export interface RewardRequest {
  redemptionId: string; // our reference; the platform stores it
  externalPlayerId: string;
  reward: { type: "bonus"; amountMinor: number; currency: string };
}

export interface TenantConnection {
  tenantId: string;
  platformUrl: string;
  platformKey: string;
  webhookSecret: string;
}

/** Thrown when a call did not give a usable answer (timeout, connection lost, 5xx, 429). The outcome is unknown. */
export class PlatformUnreachable extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface CasinoPlatform {
  /**
   * Checks the signature and translates. Throws InvalidSignature or InvalidPayload.
   * `rawBody` is the exact bytes received; signatures are computed over them.
   */
  parseEvents(
    conn: TenantConnection,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    now: Date,
  ): PlatformEvent[];

  /** Same check, for the platform's message about a reward. Platforms that answer at once throw NotSupported. */
  parseRewardNotice(
    conn: TenantConnection,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    now: Date,
  ): RewardNotice;

  /** Asks the platform to issue the reward. Throws PlatformUnreachable when the outcome is unknown. */
  issueReward(conn: TenantConnection, request: RewardRequest): Promise<RewardOutcome>;

  /**
   * Looks a reward up by our reference. "not_found" means the platform never got the request.
   * The rule for every retry: look first, then repeat.
   */
  findReward(conn: TenantConnection, redemptionId: string): Promise<RewardOutcome | "not_found">;
}

export class InvalidSignature extends Error {}
export class InvalidPayload extends Error {}
export class NotSupported extends Error {}

/** Injection token for the registry: `platforms.for(tenant.platform)` returns a CasinoPlatform. */
export const PLATFORMS = Symbol("PLATFORMS");
export interface Platforms {
  for(platform: "A" | "B"): CasinoPlatform;
}
