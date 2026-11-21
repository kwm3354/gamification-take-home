import { expectedPrizeCoins } from "../alerts/alerts.ts";
import type { Db } from "../db.ts";

type Q = Pick<Db, "query">;

const iso = (d: Date) => new Date(d).toISOString();

/** Everything the tenant's settings page shows. Versions are newest first. */
export async function readSettings(db: Q, tenantId: string) {
  const versions = async (table: "wheel_configs" | "grant_policies" | "ops_policies", column: string) =>
    (
      await db.query(
        `SELECT id, version, created_at, ${column} AS data FROM ${table} WHERE tenant_id = $1 ORDER BY version DESC`,
        [tenantId],
      )
    ).rows;
  const wheel = await versions("wheel_configs", "segments");
  const grant = await versions("grant_policies", "params");
  const ops = await versions("ops_policies", "params");
  const items = await db.query(
    "SELECT id, code, name, cost_coins, reward, active FROM store_items WHERE tenant_id = $1 ORDER BY code",
    [tenantId],
  );
  const changes = await db.query(
    "SELECT * FROM settings_changes WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50",
    [tenantId],
  );
  return {
    wheel: wheel.map((r) => ({
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at),
      segments: r.data,
      expectedPrizeCoins: Math.round(expectedPrizeCoins(r.data) * 100) / 100,
    })),
    grantPolicies: grant.map((r) => ({
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at),
      params: r.data,
    })),
    opsPolicies: ops.map((r) => ({
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at),
      params: r.data,
    })),
    storeItems: items.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      costCoins: String(r.cost_coins),
      reward: r.reward,
      active: r.active,
    })),
    changes: changes.rows.map(changeView),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a pg row
export function changeView(r: any) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    proposed: r.proposed,
    status: r.status,
    expectedPrizeCoins: Number(r.expected_prize_coins),
    limitCoins: Number(r.limit_coins),
    proposedBy: r.proposed_by,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    resultId: r.result_id,
    createdAt: iso(r.created_at),
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
  };
}
