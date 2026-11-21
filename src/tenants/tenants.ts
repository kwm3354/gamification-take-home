import type { Db } from "../db.ts";
import { activeSecrets } from "./active-secrets.ts";

export interface Tenant {
  id: string;
  name: string;
  platform: "A" | "B";
  ledgerNo: number;
  webhookSecret: string;
  webhookSecretPrev: string | null;
  webhookSecretPrevUntil: Date | null;
  webhookSecretRotatedAt: Date | null;
  tokenSecret: string;
  tokenSecretPrev: string | null;
  tokenSecretPrevUntil: Date | null;
  tokenSecretRotatedAt: Date | null;
  wheelSecret: string;
  platformUrl: string;
  platformKey: string;
}

/** Every event signing secret that is valid at `now`: the current one, and the previous one until its time. */
export const activeWebhookSecrets = (t: Tenant, now: Date): string[] =>
  activeSecrets(t.webhookSecret, t.webhookSecretPrev, t.webhookSecretPrevUntil, now);

/** Every player token secret that is valid at `now`. */
export const activeTokenSecrets = (t: Tenant, now: Date): string[] =>
  activeSecrets(t.tokenSecret, t.tokenSecretPrev, t.tokenSecretPrevUntil, now);

export async function findTenant(db: Pick<Db, "query">, id: string): Promise<Tenant | null> {
  const result = await db.query("SELECT * FROM tenants WHERE id = $1", [id]);
  const r = result.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    ledgerNo: r.ledger_no,
    webhookSecret: r.webhook_secret,
    webhookSecretPrev: r.webhook_secret_prev,
    webhookSecretPrevUntil: r.webhook_secret_prev_until,
    webhookSecretRotatedAt: r.webhook_secret_rotated_at,
    tokenSecret: r.token_secret,
    tokenSecretPrev: r.token_secret_prev,
    tokenSecretPrevUntil: r.token_secret_prev_until,
    tokenSecretRotatedAt: r.token_secret_rotated_at,
    wheelSecret: r.wheel_secret,
    platformUrl: r.platform_url,
    platformKey: r.platform_key,
  };
}
