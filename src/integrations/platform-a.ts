import {
  type CasinoPlatform,
  InvalidPayload,
  InvalidSignature,
  NotSupported,
  type PlatformEvent,
  type RewardNotice,
  type RewardOutcome,
  type RewardRequest,
  type TenantConnection,
} from "../domain/casino-platform.ts";
import { hmacMatches, isNonEmptyString, isObject, parseJson } from "./hmac.ts";

const MAX_SKEW_SECONDS = 300;

/** Platform "Alpha": signed events, answers reward requests at once. */
export class PlatformA implements CasinoPlatform {
  parseEvents(
    conn: TenantConnection,
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    now: Date,
  ): PlatformEvent[] {
    const timestamp = headers["x-alpha-timestamp"];
    const signature = headers["x-alpha-signature"];
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) throw new InvalidSignature();
    if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) throw new InvalidSignature();
    if (!hmacMatches(conn.webhookSecret, `${timestamp}.${rawBody.toString("utf8")}`, signature, "hex")) {
      throw new InvalidSignature();
    }

    let body: unknown;
    try {
      body = parseJson(rawBody);
    } catch {
      throw new InvalidPayload("not JSON");
    }
    if (!isObject(body)) throw new InvalidPayload("not an object");
    if (!isNonEmptyString(body.event_id)) throw new InvalidPayload("event_id");
    if (typeof body.type !== "string") throw new InvalidPayload("type");
    if (body.type !== "deposit.succeeded") {
      return [{ kind: "ignored", externalEventId: body.event_id, why: `type ${body.type}` }];
    }
    if (!isNonEmptyString(body.player_id)) throw new InvalidPayload("player_id");
    if (!Number.isSafeInteger(body.amount_minor) || (body.amount_minor as number) <= 0) {
      throw new InvalidPayload("amount_minor");
    }
    if (typeof body.currency !== "string" || !/^[A-Za-z]{3}$/.test(body.currency))
      throw new InvalidPayload("currency");
    const occurred = typeof body.occurred_at === "string" ? Date.parse(body.occurred_at) : Number.NaN;
    if (Number.isNaN(occurred)) throw new InvalidPayload("occurred_at");
    return [
      {
        kind: "deposit_succeeded",
        externalEventId: body.event_id,
        externalPlayerId: body.player_id,
        amountMinor: body.amount_minor as number,
        currency: body.currency.toUpperCase(),
        occurredAt: new Date(occurred).toISOString(),
      },
    ];
  }

  parseRewardNotice(): RewardNotice {
    throw new NotSupported("platform A answers reward requests at once");
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
