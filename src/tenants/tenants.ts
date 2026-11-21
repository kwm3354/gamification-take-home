import type { Db } from "../db.ts";

export interface Tenant {
  id: string;
  name: string;
  platform: "A" | "B";
  ledgerNo: number;
  webhookSecret: string;
  tokenSecret: string;
  wheelSecret: string;
  adminKey: string;
  platformUrl: string;
  platformKey: string;
}

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
    tokenSecret: r.token_secret,
    wheelSecret: r.wheel_secret,
    adminKey: r.admin_key,
    platformUrl: r.platform_url,
    platformKey: r.platform_key,
  };
}
