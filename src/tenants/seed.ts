import { hashPassword } from "../admin/password.ts";
import { create } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";
import {
  demoAdmins,
  demoGrantPolicy,
  demoOpsPolicy,
  demoStoreItems,
  demoTenants,
  demoWheelSegments,
} from "./demo-tenants.ts";

/**
 * Creates the two demo tenants, wheel version 1 and the store items. Safe to run twice: rows that
 * exist are left alone and write no audit row.
 */
export async function seedDemo(db: Db, clock: Clock, fakeCasinoUrl: string): Promise<void> {
  // Hash only the users that do not exist yet, outside the transaction (scrypt is slow on purpose).
  const have = new Set((await db.query("SELECT email FROM admin_users")).rows.map((r) => r.email as string));
  const hashes = new Map<string, string>();
  for (const u of demoAdmins) if (!have.has(u.email)) hashes.set(u.email, await hashPassword(u.password));
  await transaction(db, async (tx) => {
    for (const t of demoTenants) {
      const ctx = { tenantId: t.id, actor: "system/seed", now: clock.now() };
      await create(
        tx,
        ctx,
        "tenants",
        {
          id: t.id,
          name: t.name,
          platform: t.platform,
          ledger_no: t.ledgerNo,
          webhook_secret: t.webhookSecret,
          token_secret: t.tokenSecret,
          wheel_secret: t.wheelSecret,
          platform_url: fakeCasinoUrl,
          platform_key: t.platformKey,
        },
        { onConflict: "nothing" },
      );
      await create(
        tx,
        ctx,
        "wheel_configs",
        { tenant_id: t.id, version: 1, segments: demoWheelSegments },
        { onConflict: "nothing" },
      );
      await create(
        tx,
        ctx,
        "grant_policies",
        { tenant_id: t.id, version: 1, params: demoGrantPolicy },
        { onConflict: "nothing" },
      );
      await create(
        tx,
        ctx,
        "ops_policies",
        { tenant_id: t.id, version: 1, params: demoOpsPolicy },
        { onConflict: "nothing" },
      );
      for (const item of demoStoreItems) {
        await create(
          tx,
          ctx,
          "store_items",
          {
            tenant_id: t.id,
            code: item.code,
            name: item.name,
            cost_coins: item.costCoins,
            reward: item.reward,
          },
          { onConflict: "nothing" },
        );
      }
    }
    for (const u of demoAdmins) {
      const hash = hashes.get(u.email);
      if (!hash) continue;
      await create(
        tx,
        { tenantId: u.tenantId, actor: "system/seed", now: clock.now() },
        "admin_users",
        { email: u.email, name: u.name, password_hash: hash, role: u.role, tenant_id: u.tenantId },
        { onConflict: "nothing" },
      );
    }
  });
}
