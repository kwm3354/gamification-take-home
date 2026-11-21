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
import { callPlatform, unexpectedAnswer } from "./http.ts";

/** 500 -> "5.00", 5 -> "0.05". Integer arithmetic only. */
function toDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error(`bad amount ${minor}`);
  const whole = Math.trunc(minor / 100);
  return `${whole}.${String(minor % 100).padStart(2, "0")}`;
}

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

  async issueReward(conn: TenantConnection, request: RewardRequest): Promise<RewardOutcome> {
    // B has no idempotency key: a second call with the same externalRef makes a second grant.
    // The caller must have looked first (findReward) before it calls this.
    const reply = await callPlatform(conn, "POST", "/b/v2/rewards/grant", {
      headers: { "x-api-key": conn.platformKey },
      json: {
        customerId: request.externalPlayerId,
        reward: {
          type: request.reward.type.toUpperCase(),
          value: toDecimal(request.reward.amountMinor),
          currency: request.reward.currency,
        },
        externalRef: request.redemptionId,
      },
    });
    const b = reply.body;
    if (reply.status === 202 && isObject(b) && b.state === "ACCEPTED" && isNonEmptyString(b.requestId)) {
      return { kind: "pending", platformRef: b.requestId };
    }
    throw unexpectedAnswer("issue", reply);
  }

  async findReward(conn: TenantConnection, redemptionId: string): Promise<RewardOutcome | "not_found"> {
    const reply = await callPlatform(
      conn,
      "GET",
      `/b/v2/rewards/requests?externalRef=${encodeURIComponent(redemptionId)}`,
      { headers: { "x-api-key": conn.platformKey } },
    );
    const b = reply.body;
    if (reply.status !== 200 || !isObject(b) || !Array.isArray(b.items))
      throw unexpectedAnswer("find", reply);
    if (b.items.length === 0) return "not_found";
    const items = b.items.map((item: unknown) => {
      if (!isObject(item) || !isNonEmptyString(item.requestId)) {
        throw unexpectedAnswer("find (bad item)", reply);
      }
      if (item.state !== "GRANTED" && item.state !== "ACCEPTED" && item.state !== "DECLINED") {
        throw unexpectedAnswer("find (unknown state)", reply);
      }
      return { requestId: item.requestId, state: item.state, reason: item.reason };
    });
    // There can be several requests for one reference (B does not deduplicate). A real grant must
    // not be hidden by a duplicate, so GRANTED wins over ACCEPTED, and ACCEPTED over DECLINED.
    const granted = items.find((i) => i.state === "GRANTED");
    if (granted) return { kind: "issued", platformRef: granted.requestId };
    const accepted = items.find((i) => i.state === "ACCEPTED");
    if (accepted) return { kind: "pending", platformRef: accepted.requestId };
    const reason = items[0]?.reason;
    return { kind: "refused", reason: isNonEmptyString(reason) ? reason : "declined" };
  }
}
