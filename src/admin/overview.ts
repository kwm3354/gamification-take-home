import { runAlerts } from "../alerts/alerts.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { type CoinLedger, LedgerUnavailable } from "../domain/coin-ledger.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUSES = ["created", "reserved", "submitting", "issued", "refused", "insufficient"] as const;

/** The numbers on the first page of the back office. Every query filters by tenant. */
export async function overview(
  deps: { db: Db; clock: Clock; coins: CoinLedger },
  tenant: { id: string; ledgerNo: number },
) {
  const { db, clock } = deps;
  const now = clock.now();
  const q = async (sql: string, params: unknown[]) => (await db.query(sql, [tenant.id, ...params])).rows;

  const players = Number((await q("SELECT count(*) AS n FROM players WHERE tenant_id = $1", []))[0]?.n);
  const events = await q(
    `SELECT count(*) FILTER (WHERE kind <> 'ignored')::int AS accepted,
            count(*) FILTER (WHERE kind = 'ignored')::int AS ignored
       FROM inbound_events WHERE tenant_id = $1 AND received_at > $2`,
    [new Date(now.getTime() - DAY_MS)],
  );
  const spins = await q(
    `SELECT count(*) FILTER (WHERE status = 'available')::int AS available,
            count(*) FILTER (WHERE status = 'used')::int AS used
       FROM spins WHERE tenant_id = $1`,
    [],
  );
  const reds = await q(
    `SELECT status, count(*)::int AS n, count(*) FILTER (WHERE status IN ('issued', 'refused') AND settled_at IS NULL)::int AS unsettled
       FROM redemptions WHERE tenant_id = $1 GROUP BY status`,
    [],
  );
  const redemptions: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let unsettled = 0;
  for (const r of reds) {
    redemptions[r.status as string] = r.n;
    unsettled += r.unsettled;
  }
  const outbox = await q(
    `SELECT count(*) FILTER (WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= $2)::int AS due,
            count(*) FILTER (WHERE done_at IS NULL AND dead_at IS NULL AND run_at > $2)::int AS waiting,
            count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead
       FROM outbox WHERE tenant_id = $1`,
    [now],
  );
  const versions = await q(
    `SELECT (SELECT max(version) FROM wheel_configs WHERE tenant_id = $1) AS wheel,
            (SELECT max(version) FROM grant_policies WHERE tenant_id = $1) AS grant_policy,
            (SELECT max(version) FROM ops_policies WHERE tenant_id = $1) AS ops`,
    [],
  );
  const alerts = (await runAlerts(db, clock, tenant.id)).alerts;

  // The page must load even when the ledger is away.
  let coinsOutstanding: string | null = null;
  try {
    coinsOutstanding = String(await deps.coins.outstanding({ ledgerNo: tenant.ledgerNo }));
  } catch (e) {
    if (!(e instanceof LedgerUnavailable)) throw e;
  }

  return {
    at: now.toISOString(),
    players,
    events24h: { accepted: events[0]?.accepted as number, ignored: events[0]?.ignored as number },
    spins: { available: spins[0]?.available as number, used: spins[0]?.used as number },
    redemptions: { ...redemptions, unsettled },
    coinsOutstanding,
    outbox: {
      due: outbox[0]?.due as number,
      waiting: outbox[0]?.waiting as number,
      dead: outbox[0]?.dead as number,
    },
    alerts: {
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
    },
    settings: {
      wheelVersion: (versions[0]?.wheel as number | null) ?? null,
      grantPolicyVersion: (versions[0]?.grant_policy as number | null) ?? null,
      opsPolicyVersion: (versions[0]?.ops as number | null) ?? null,
    },
  };
}
