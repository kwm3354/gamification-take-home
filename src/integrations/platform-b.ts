import {
  type CasinoPlatform,
  InvalidPayload,
  InvalidSignature,
  type PlatformEvent,
  type RewardNotice,
  type RewardOutcome,
  type RewardRequest,
  type TenantConnection,
} from "../domain/casino-platform.ts";
import { hmacMatches, isNonEmptyString, isObject, parseJson } from "./hmac.ts";

function checkSignature(
  conn: TenantConnection,
  headers: Record<string, string | undefined>,
  rawBody: Buffer,
): void {
  const given = headers["x-beta-auth"];
  if (!given || !hmacMatches(conn.webhookSecret, rawBody, given, "base64")) throw new InvalidSignature();
}

function body(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJson(rawBody);
  } catch {
    throw new InvalidPayload("not JSON");
  }
  if (!isObject(parsed)) throw new InvalidPayload("not an object");
  return parsed;
}

/** "20.50" -> 2050 without floating point. Anything but one or two decimals is invalid. */
function toMinor(amount: unknown): number {
  if (typeof amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(amount)) throw new InvalidPayload("amount");
  const [whole = "0", fraction = ""] = amount.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new InvalidPayload("amount");
  return minor;
}

/** Platform "Beta": batches signed over the raw body; reward results arrive by webhook. */
export class PlatformB implements CasinoPlatform {
  parseEvents(
    conn: TenantConnection,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    _now: Date,
  ): PlatformEvent[] {
    checkSignature(conn, headers, rawBody);
    const parsed = body(rawBody);
    const list = parsed.transactions;
    if (!Array.isArray(list) || list.length === 0) throw new InvalidPayload("transactions");
    // Every entry is checked before any is returned: one bad entry fails the whole batch.
    return list.map((entry): PlatformEvent => {
      if (!isObject(entry) || !isNonEmptyString(entry.txnId)) throw new InvalidPayload("txnId");
      if (entry.kind !== "DEPOSIT" || entry.state !== "COMPLETED") {
        return {
          kind: "ignored",
          externalEventId: entry.txnId,
          why: `${String(entry.kind)} ${String(entry.state)}`,
        };
      }
      const customer = entry.customer;
      if (!isObject(customer) || !isNonEmptyString(customer.id)) throw new InvalidPayload("customer.id");
      const amountMinor = toMinor(entry.amount);
      if (typeof entry.currencyCode !== "string" || !/^[A-Za-z]{3}$/.test(entry.currencyCode)) {
        throw new InvalidPayload("currencyCode");
      }
      if (typeof entry.completedAt !== "number" || !Number.isFinite(entry.completedAt)) {
        throw new InvalidPayload("completedAt");
      }
      return {
        kind: "deposit_succeeded",
        externalEventId: entry.txnId,
        externalPlayerId: customer.id,
        amountMinor,
        currency: entry.currencyCode.toUpperCase(),
        occurredAt: new Date(entry.completedAt * 1000).toISOString(),
      };
    });
  }

  parseRewardNotice(
    conn: TenantConnection,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    _now: Date,
  ): RewardNotice {
    checkSignature(conn, headers, rawBody);
    const b = body(rawBody);
    if (!isNonEmptyString(b.requestId) || !isNonEmptyString(b.externalRef)) throw new InvalidPayload("ids");
    if (b.state === "GRANTED") {
      return { redemptionId: b.externalRef, outcome: { kind: "issued", platformRef: b.requestId } };
    }
    if (b.state === "DECLINED") {
      const reason = isNonEmptyString(b.reason) ? b.reason : "declined";
      return { redemptionId: b.externalRef, outcome: { kind: "refused", reason } };
    }
    throw new InvalidPayload("state");
  }

  issueReward(_conn: TenantConnection, _request: RewardRequest): Promise<RewardOutcome> {
    // Added by a later agent (outbound half).
    throw new Error("not implemented yet");
  }

  findReward(_conn: TenantConnection, _redemptionId: string): Promise<RewardOutcome | "not_found"> {
    // Added by a later agent (outbound half).
    throw new Error("not implemented yet");
  }
}
