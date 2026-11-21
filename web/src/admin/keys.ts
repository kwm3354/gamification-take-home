/** Tenant keys: the shapes of `docs/contracts.md` "Tenant keys" and the small rules the screen needs. */
export type KeyKind = "event_signing" | "player_token";

export interface KeyItem {
  kind: KeyKind;
  hint: string;
  rotatedAt: string | null;
  previous: { hint: string; validUntil: string } | null;
}

/** The answer of a replacement. `secret` is shown once and kept nowhere else. */
export interface RotateAnswer {
  kind: KeyKind;
  secret: string;
  hint: string;
  previous: { hint: string; validUntil: string } | null;
}

export const KEY_NAMES: Record<KeyKind, string> = {
  event_signing: "Event signing key",
  player_token: "Player token key",
};

/** What the old key does after a replacement. The seconds go to the server as `previousValidForSec`. */
export const KEEP_CHOICES = [
  { id: "now", seconds: 0, label: "Stops working now (use after a leak)" },
  { id: "1h", seconds: 3600, label: "Keeps working 1 hour" },
  { id: "24h", seconds: 86400, label: "Keeps working 24 hours" },
] as const;

export type KeepId = (typeof KEEP_CHOICES)[number]["id"];

export const secondsOf = (id: KeepId): number => KEEP_CHOICES.find((c) => c.id === id)?.seconds ?? 0;

/** The one sentence the confirm step shows: what the casino will notice. */
export function consequence(kind: KeyKind, id: KeepId): string {
  const what = kind === "event_signing" ? "Events signed with the old key" : "Player tokens signed with the old key";
  if (id === "now") return `${what} will be rejected from now on.`;
  return `${what} will be rejected after ${id === "1h" ? "1 hour" : "24 hours"}.`;
}

/** The address of the demo casino's control call that takes a new key. */
export const fakeCasinoSecretsUrl = (base: string, tenantId: string): string =>
  `${base.replace(/\/$/, "")}/control/tenants/${encodeURIComponent(tenantId)}/secrets`;

/** The body of that call: the casino's configuration field that belongs to this kind of key. */
export const fakeCasinoSecretsBody = (kind: KeyKind, secret: string): Record<string, string> =>
  kind === "event_signing" ? { webhookSecret: secret } : { tokenSecret: secret };
