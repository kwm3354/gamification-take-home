export type Platform = "A" | "B";

export interface CasinoTenant {
  id: string;
  name: string;
  platform: Platform;
  adminKey: string;
}

export interface Player {
  /** `${tenantId}:${externalId}` */
  key: string;
  tenantId: string;
  externalId: string;
  token: string;
  /** Milliseconds since the epoch, read from the token. */
  expiresAt: number;
}

export interface Balance {
  available: string;
  reserved: string;
}

export interface Spin {
  id: string;
  status: string;
  coins: string | null;
}

export interface Me {
  playerId: string;
  tenantId: string;
  balance: Balance | null;
  spins: Spin[];
}

export interface Segment {
  label: string;
  coins: number;
}

export interface StoreItem {
  id: string;
  code: string;
  name: string;
  costCoins: string;
  reward: { type: string; currency: string; amountMinor: number };
}

export interface RedemptionData {
  id: string;
  status: string;
  costCoins: string;
  reason: string | null;
  platformRef?: string | null;
  settled?: boolean;
}

/** A redemption made in this session. The status is read from the server; only the ids are kept. */
export interface Tracked {
  id: string;
  playerKey: string;
  tenantId: string;
  itemName: string;
  createdAt: number;
  data: RedemptionData | null;
}

export type Actor = "player -> us" | "admin -> us" | "casino -> us" | "page -> casino";

export interface LogEntry {
  id: number;
  at: number;
  actor: Actor;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  error: string | null;
  /** A label the page sets so the timeline can tell why a call was made (for example `after-spin`). */
  tag: string | null;
}
