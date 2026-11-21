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
import { hmacMatchesAny, isNonEmptyString, isObject, parseJson, verifyingSecrets } from "./hmac.ts";
import { callPlatform, unexpectedAnswer } from "./http.ts";

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
    const signed = `${timestamp}.${rawBody.toString("utf8")}`;
    if (!hmacMatchesAny(verifyingSecrets(conn), signed, signature, "hex")) {
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
      return [
        { kind: "ignored", externalEventId: `${body.event_id}:${body.type}`, why: `type ${body.type}` },
      ];
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

  async issueReward(conn: TenantConnection, request: RewardRequest): Promise<RewardOutcome> {
    const reply = await callPlatform(conn, "POST", "/a/bonuses", {
      headers: {
        authorization: `Bearer ${conn.platformKey}`,
        // A keeps the first answer for a key, so a repeated call grants nothing new.
        "idempotency-key": request.redemptionId,
      },
      json: {
        player_id: request.externalPlayerId,
        amount_minor: request.reward.amountMinor,
        currency: request.reward.currency,
        reference: request.redemptionId,
      },
    });
    if (reply.status === 201) {
      const b = reply.body;
      if (isObject(b) && b.status === "granted" && isNonEmptyString(b.bonus_id)) {
        return { kind: "issued", platformRef: b.bonus_id };
      }
      throw unexpectedAnswer("issue (201 with a body we do not know)", reply);
    }
    if (reply.status === 422) {
      const b = reply.body;
      return { kind: "refused", reason: isObject(b) && isNonEmptyString(b.error) ? b.error : "rejected" };
    }
    throw unexpectedAnswer("issue", reply);
  }

  async findReward(conn: TenantConnection, redemptionId: string): Promise<RewardOutcome | "not_found"> {
    const reply = await callPlatform(
      conn,
      "GET",
      `/a/bonuses?reference=${encodeURIComponent(redemptionId)}`,
      { headers: { authorization: `Bearer ${conn.platformKey}` } },
    );
    if (reply.status === 404) return "not_found";
    if (reply.status === 200 && isObject(reply.body)) {
      const b = reply.body;
      if (b.status === "granted" && isNonEmptyString(b.bonus_id)) {
        return { kind: "issued", platformRef: b.bonus_id };
      }
      if (b.status === "rejected") {
        return { kind: "refused", reason: isNonEmptyString(b.error) ? b.error : "rejected" };
      }
    }
    throw unexpectedAnswer("find", reply);
  }
}
