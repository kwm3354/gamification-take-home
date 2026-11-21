import { now } from "./clock.ts";

export type Platform = "A" | "B";

export interface Grant {
  tenantId: string;
  platform: Platform;
  playerId: string;
  reference: string;
  amountMinor: number;
  currency: string;
  platformRef: string;
  at: string;
}

export interface RequestLog {
  tenantId: string;
  point: string;
  reference: string | null;
  at: string;
  fault: string | null;
}

export interface CallbackRecord {
  tenantId: string;
  requestId: string;
  externalRef: string;
  /** The final state the request will have (or has) after delivery. */
  finalState: "GRANTED" | "DECLINED";
  status: "queued" | "delivering" | "delivered" | "lost";
  sentCount: number;
}

export interface FakeState {
  grants: Grant[];
  requests: RequestLog[];
  callbacks: CallbackRecord[];
}

export interface BRequest {
  tenantId: string;
  requestId: string;
  externalRef: string;
  customerId: string;
  valueMinor: number;
  currency: string;
  state: "ACCEPTED" | "GRANTED" | "DECLINED";
  plannedState: "GRANTED" | "DECLINED";
  reason?: string;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const isoNow = (): string => new Date(now()).toISOString();

/** Everything the fake remembers. One object so reset is one call. */
export class World {
  grants: Grant[] = [];
  requests: RequestLog[] = [];
  callbacks: CallbackRecord[] = [];
  bRequests: BRequest[] = [];
  /** Platform A: tenant|Idempotency-Key -> the first answer. */
  idempotency = new Map<string, Reply>();
  /** Platform A: tenant|reference -> refusal reason. */
  rejected = new Map<string, string>();
  private bonusSeq = 0;
  private requestSeq = 0;

  nextBonusId(): string {
    this.bonusSeq += 1;
    return `b_${this.bonusSeq}`;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `r_${this.requestSeq}`;
  }

  snapshot(): FakeState {
    return structuredClone({
      grants: this.grants,
      requests: this.requests,
      callbacks: this.callbacks,
    });
  }

  reset(): void {
    this.grants = [];
    this.requests = [];
    this.callbacks = [];
    this.bRequests = [];
    this.idempotency.clear();
    this.rejected.clear();
    this.bonusSeq = 0;
    this.requestSeq = 0;
  }
}

/** "5.00" -> 500. Only plain decimal strings with at most two places. */
export function toMinor(amount: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}
