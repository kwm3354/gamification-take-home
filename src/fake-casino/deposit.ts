import { randomUUID } from "node:crypto";
import type { DemoTenant } from "../tenants/demo-tenants.ts";
import { now } from "./clock.ts";
import { breakSignature, hmacBase64, hmacHex } from "./signing.ts";
import { toMinor } from "./state.ts";

export interface DepositInput {
  tenant: DemoTenant;
  playerId: string;
  amount: string;
  currency: string;
  eventId: string;
  tamper?: string;
}

/** The exact bytes to send and the headers that sign them, in the tenant's platform format. */
export function buildDeposit(input: DepositInput): { raw: string; headers: Record<string, string> } {
  const { tenant, tamper } = input;
  const seconds = Math.floor(now() / 1000);
  if (tenant.platform === "A") {
    const raw = JSON.stringify({
      event_id: input.eventId,
      type: tamper === "failed" ? "deposit.failed" : "deposit.succeeded",
      player_id: input.playerId,
      amount_minor: toMinor(input.amount),
      currency: input.currency,
      occurred_at: new Date(seconds * 1000).toISOString(),
    });
    const timestamp = String(tamper === "stale" ? seconds - 3600 : seconds);
    let signature = hmacHex(tenant.webhookSecret, `${timestamp}.${raw}`);
    if (tamper === "signature") signature = breakSignature(signature);
    return { raw, headers: { "X-Alpha-Timestamp": timestamp, "X-Alpha-Signature": signature } };
  }
  const raw = JSON.stringify({
    batchId: `batch-${input.eventId}`,
    transactions: [
      {
        txnId: input.eventId,
        kind: "DEPOSIT",
        state: tamper === "failed" ? "FAILED" : "COMPLETED",
        customer: { id: input.playerId },
        amount: input.amount,
        currencyCode: input.currency,
        completedAt: seconds,
      },
    ],
  });
  let signature = hmacBase64(tenant.webhookSecret, raw);
  if (tamper === "signature") signature = breakSignature(signature);
  return { raw, headers: { "X-Beta-Auth": signature } };
}

export const newEventId = (): string => `evt_${randomUUID().slice(0, 8)}`;
