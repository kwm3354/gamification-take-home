import { createHmac } from "node:crypto";

/** Signing helpers for tests. Written on their own, not imported from src/integrations. */

const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data);

export function signAlpha(secret: string, body: string, nowMs: number, skewSeconds = 0) {
  const timestamp = String(Math.floor(nowMs / 1000) + skewSeconds);
  return {
    "content-type": "application/json",
    "x-alpha-timestamp": timestamp,
    "x-alpha-signature": hmac(secret, `${timestamp}.${body}`).digest("hex"),
  };
}

export function signBeta(secret: string, body: string) {
  return { "content-type": "application/json", "x-beta-auth": hmac(secret, body).digest("base64") };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function playerToken(
  secret: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const signingInput = `${b64(header)}.${b64(claims)}`;
  return `${signingInput}.${hmac(secret, signingInput).digest("base64url")}`;
}

/** A valid token for `sub` in `tenant`, valid for `ttlSeconds` from `nowMs`. */
export function tokenFor(
  tenant: string,
  secret: string,
  sub: string,
  nowMs: number,
  ttlSeconds = 600,
): string {
  return playerToken(secret, { iss: tenant, sub, exp: Math.floor(nowMs / 1000) + ttlSeconds });
}

export function alphaDeposit(eventId: string, playerId: string, amountMinor = 2000) {
  return JSON.stringify({
    event_id: eventId,
    type: "deposit.succeeded",
    player_id: playerId,
    amount_minor: amountMinor,
    currency: "EUR",
    occurred_at: "2026-11-21T08:00:00Z",
  });
}

export function betaTxn(txnId: string, customerId: string, extra: Record<string, unknown> = {}) {
  return {
    txnId,
    kind: "DEPOSIT",
    state: "COMPLETED",
    customer: { id: customerId },
    amount: "20.00",
    currencyCode: "EUR",
    completedAt: 1795000000,
    ...extra,
  };
}
