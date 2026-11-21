import { randomBytes } from "node:crypto";
import { update } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";
import type { Log } from "../logging/log.ts";
import { activeSecrets } from "../tenants/active-secrets.ts";

/**
 * Replacing a tenant's secrets. Two kinds: the casino signs its events with the event signing
 * secret, and signs player tokens with the player token secret. A replacement moves the current
 * value to "previous" (valid until a time the admin chose; 0 means not valid at all) and makes a new
 * one. The audit function `update` locks the tenant row, so two replacements at once run one after
 * the other. Plain code, no HTTP.
 */
export type KeyKind = "event_signing" | "player_token";
export const KEY_KINDS: KeyKind[] = ["event_signing", "player_token"];

// kind -> column name and the readable prefix of a new secret
const COLUMNS: Record<KeyKind, { column: string; prefix: string }> = {
  event_signing: { column: "webhook_secret", prefix: "evs_" },
  player_token: { column: "token_secret", prefix: "pts_" },
};

export interface KeyItem {
  kind: KeyKind;
  hint: string;
  rotatedAt: string | null;
  previous: { hint: string; validUntil: string } | null;
}

export const MAX_PREVIOUS_SEC = 86_400;

/** First 4 and last 4 characters. Never the whole secret (a short secret is shown as a dot only). */
export function hint(secret: string): string {
  return secret.length < 12 ? "…" : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

type Row = Record<string, unknown>;

function item(kind: KeyKind, row: Row, now: Date): KeyItem {
  const { column } = COLUMNS[kind];
  const current = row[column] as string;
  const prev = row[`${column}_prev`] as string | null;
  const until = row[`${column}_prev_until`] as Date | null;
  const rotatedAt = row[`${column}_rotated_at`] as Date | null;
  const live = prev !== null && activeSecrets(current, prev, until, now).length === 2;
  return {
    kind,
    hint: hint(current),
    rotatedAt: rotatedAt ? rotatedAt.toISOString() : null,
    previous: live && prev && until ? { hint: hint(prev), validUntil: until.toISOString() } : null,
  };
}

export async function listKeys(db: Db, clock: Clock, tenantId: string): Promise<KeyItem[] | null> {
  const r = await db.query("SELECT * FROM tenants WHERE id = $1", [tenantId]);
  const row = r.rows[0] as Row | undefined;
  if (!row) return null;
  const now = clock.now();
  return KEY_KINDS.map((kind) => item(kind, row, now));
}

interface Deps {
  db: Db;
  clock: Clock;
  log: Log;
}

/** Makes a new secret. The full value is in the answer and nowhere else. */
export async function rotateKey(
  deps: Deps,
  adminId: string,
  tenantId: string,
  kind: KeyKind,
  previousValidForSec: number,
): Promise<(KeyItem & { secret: string }) | null> {
  const { column, prefix } = COLUMNS[kind];
  const now = deps.clock.now();
  const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
  const ctx = { tenantId, actor: `admin/${adminId}`, now };
  const done = await transaction(deps.db, (tx) =>
    update(tx, ctx, "tenants", tenantId, (current) => {
      const until = new Date(now.getTime() + previousValidForSec * 1000);
      return {
        [column]: secret,
        [`${column}_prev`]: previousValidForSec > 0 ? current[column] : null,
        [`${column}_prev_until`]: previousValidForSec > 0 ? until : null,
        [`${column}_rotated_at`]: now,
      };
    }),
  );
  if (!done) return null;
  deps.log.event("info", "tenant.key_rotated", {
    tenantId,
    adminId,
    kind,
    previousValidForSec,
    hint: hint(secret),
  });
  return { ...item(kind, done.after, now), secret };
}

/** Clears the previous secret now. Nothing to clear is not an error: it answers the same item. */
export async function revokePrevious(
  deps: Deps,
  adminId: string,
  tenantId: string,
  kind: KeyKind,
): Promise<KeyItem | null> {
  const { column } = COLUMNS[kind];
  const now = deps.clock.now();
  const ctx = { tenantId, actor: `admin/${adminId}`, now };
  const result = await transaction(deps.db, async (tx) => {
    const done = await update(tx, ctx, "tenants", tenantId, (current) =>
      current[`${column}_prev`] === null
        ? null
        : { [`${column}_prev`]: null, [`${column}_prev_until`]: null },
    );
    if (done) return { row: done.after, changed: true };
    const r = await tx.query("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    return { row: r.rows[0] as Row | undefined, changed: false };
  });
  if (!result.row) return null;
  if (result.changed) deps.log.event("info", "tenant.key_previous_revoked", { tenantId, adminId, kind });
  return item(kind, result.row, now);
}
