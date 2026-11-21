import { stuckRedemptions } from "../admin/stuck.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { type OpsParams, loadOpsPolicy } from "./ops-policy.ts";

/**
 * Deterministic alerts: each one is a function with a SQL query and a comparison. They look for
 * the known ways to lose money while the ledger is consistent. What nobody foresaw is the job of
 * the daily digest (docs/monitoring-playbook.md). Every query filters by tenant and uses the
 * injected clock for its window.
 */

export interface Alert {
  code: string;
  severity: "warning" | "critical";
  subject: string;
  value: number;
  limit: number;
  detail: Record<string, unknown>;
}

export interface AlertRun {
  at: string;
  policyVersion: number | null;
  alerts: Alert[];
}

type Q = Pick<Db, "query">;
interface Ctx {
  db: Q;
  clock: Clock;
  tenantId: string;
  params: OpsParams;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const since = (c: Ctx) => new Date(c.clock.now().getTime() - DAY_MS);

interface Segment {
  coins: number;
  weight: number;
}

/** sum(coins * weight) and sum(weight) as exact integers. */
function weighted(segments: Segment[]): { cw: bigint; w: bigint } {
  let cw = 0n;
  let w = 0n;
  for (const s of segments) {
    cw += BigInt(s.coins) * BigInt(s.weight);
    w += BigInt(s.weight);
  }
  return { cw, w };
}

/** True when the expected prize is above the limit. Exact on integers when the limit is a whole number. */
export function expectedPrizeAbove(segments: Segment[], limit: number): boolean {
  const { cw, w } = weighted(segments);
  if (w === 0n) return false;
  return Number.isInteger(limit) ? cw > BigInt(limit) * w : Number(cw) / Number(w) > limit;
}

/** Expected prize per spin: sum(coins * weight) / sum(weight). 0 for a wheel without weight. */
export function expectedPrizeCoins(segments: Segment[]): number {
  const { cw, w } = weighted(segments);
  return w === 0n ? 0 : Number(cw) / Number(w);
}

export async function redemptionPendingTooLong(c: Ctx): Promise<Alert[]> {
  const items = await stuckRedemptions(c.db, c.clock, c.tenantId, c.params.pendingAgeLimitSec);
  if (items.length === 0) return [];
  const oldest = items[0]?.ageSec ?? 0; // the list is oldest first
  return [
    {
      code: "redemption_pending_too_long",
      severity: "critical",
      subject: c.tenantId,
      value: oldest,
      limit: c.params.pendingAgeLimitSec,
      detail: { count: items.length, ids: items.slice(0, 5).map((i) => i.id) },
    },
  ];
}

export async function outboxDeadJobs(c: Ctx): Promise<Alert[]> {
  const { rows } = await c.db.query(
    "SELECT count(*)::int AS n, (array_agg(id ORDER BY id))[1:5] AS ids FROM outbox WHERE tenant_id = $1 AND dead_at IS NOT NULL",
    [c.tenantId],
  );
  const n = rows[0].n as number;
  if (n === 0) return [];
  return [
    {
      code: "outbox_dead_jobs",
      severity: "critical",
      subject: c.tenantId,
      value: n,
      limit: 0,
      detail: { count: n, jobIds: rows[0].ids },
    },
  ];
}

export async function wheelExpectedPrizeHigh(c: Ctx): Promise<Alert[]> {
  const { rows } = await c.db.query(
    "SELECT version, segments FROM wheel_configs WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
    [c.tenantId],
  );
  const config = rows[0];
  if (!config) return [];
  const { cw, w } = weighted(config.segments as Segment[]);
  const limit = c.params.maxExpectedPrizeCoins;
  if (!expectedPrizeAbove(config.segments as Segment[], limit)) return [];
  return [
    {
      code: "wheel_expected_prize_high",
      severity: "warning",
      subject: c.tenantId,
      value: Number(cw) / Number(w),
      limit,
      detail: { wheelVersion: config.version, sumCoinsTimesWeight: String(cw), sumWeight: String(w) },
    },
  ];
}

export const MIN_SPINS_FOR_PAYOUT_CHECK = 200;
export const PAYOUT_ABOVE_EXPECTATION = 1.25;

export async function wheelPayingAboveExpectation(c: Ctx): Promise<Alert[]> {
  const { rows } = await c.db.query(
    `SELECT w.id, w.version, w.segments, count(*)::int AS n, sum(s.coins)::text AS coins
       FROM spins s JOIN wheel_configs w ON w.id = s.wheel_config_id
      WHERE s.tenant_id = $1 AND s.status = 'used' AND s.used_at >= $2
      GROUP BY w.id, w.version, w.segments`,
    [c.tenantId, since(c)],
  );
  let spins = 0;
  let paid = 0;
  let expected = 0;
  for (const r of rows) {
    const { cw, w } = weighted(r.segments as Segment[]);
    spins += r.n;
    paid += Number(r.coins);
    expected += (r.n * Number(cw)) / Number(w);
  }
  if (spins < MIN_SPINS_FOR_PAYOUT_CHECK || expected <= 0) return [];
  if (paid <= expected * PAYOUT_ABOVE_EXPECTATION) return [];
  return [
    {
      code: "wheel_paying_above_expectation",
      severity: "warning",
      subject: c.tenantId,
      value: paid / spins,
      limit: (expected * PAYOUT_ABOVE_EXPECTATION) / spins,
      detail: { spins, meanPrize: paid / spins, expectedMeanPrize: expected / spins, windowHours: 24 },
    },
  ];
}

export async function manySpinsOnePlayer(c: Ctx): Promise<Alert[]> {
  // "Granted" is counted from the deposit event's time, which comes from the injected clock.
  const { rows } = await c.db.query(
    `SELECT p.external_id, count(*)::int AS n
       FROM spins s
       JOIN inbound_events e ON e.id = s.source_event_id
       JOIN players p ON p.id = s.player_id
      WHERE s.tenant_id = $1 AND e.received_at >= $2
      GROUP BY p.external_id
     HAVING count(*) > $3
      ORDER BY n DESC, p.external_id`,
    [c.tenantId, since(c), c.params.maxSpinsPerPlayerPerDay],
  );
  return rows.map((r) => ({
    code: "many_spins_one_player",
    severity: "warning" as const,
    subject: `player/${r.external_id}`,
    value: r.n as number,
    limit: c.params.maxSpinsPerPlayerPerDay,
    detail: { windowHours: 24 },
  }));
}

export async function playerRedeemShareHigh(c: Ctx): Promise<Alert[]> {
  const { rows } = await c.db.query(
    `SELECT p.external_id, sum(r.cost_coins)::text AS coins
       FROM redemptions r JOIN players p ON p.id = r.player_id
      WHERE r.tenant_id = $1 AND r.status = 'issued' AND r.created_at >= $2
      GROUP BY p.external_id`,
    [c.tenantId, since(c)],
  );
  const total = rows.reduce((sum, r) => sum + BigInt(r.coins), 0n);
  if (total === 0n || total < BigInt(Math.ceil(c.params.minRedeemedForShare))) return [];
  const alerts: Alert[] = [];
  for (const r of rows) {
    const share = Number(BigInt(r.coins)) / Number(total);
    if (share > c.params.maxPlayerRedeemShare) {
      alerts.push({
        code: "player_redeem_share_high",
        severity: "warning",
        subject: `player/${r.external_id}`,
        value: share,
        limit: c.params.maxPlayerRedeemShare,
        detail: { playerCoins: r.coins, tenantCoins: String(total), windowHours: 24 },
      });
    }
  }
  return alerts.sort((a, b) => b.value - a.value || a.subject.localeCompare(b.subject));
}

export async function outcomeContradicted(c: Ctx): Promise<Alert[]> {
  const { rows } = await c.db.query(
    `SELECT entity_id FROM audit_log
      WHERE tenant_id = $1 AND action = 'outcome_contradicted' AND at >= $2
      ORDER BY id`,
    [c.tenantId, since(c)],
  );
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.entity_id as string))];
  return [
    {
      code: "outcome_contradicted",
      severity: "critical",
      subject: c.tenantId,
      value: rows.length,
      limit: 0,
      detail: { redemptionIds: ids.slice(0, 20), windowHours: 24 },
    },
  ];
}

const ALL = [
  redemptionPendingTooLong,
  outboxDeadJobs,
  wheelExpectedPrizeHigh,
  wheelPayingAboveExpectation,
  manySpinsOnePlayer,
  playerRedeemShareHigh,
  outcomeContradicted,
];

/** Runs every alert for one tenant against its newest ops policy. */
export async function runAlerts(db: Q, clock: Clock, tenantId: string): Promise<AlertRun> {
  const at = clock.now().toISOString();
  const policy = await loadOpsPolicy(db, tenantId);
  if (!policy) {
    return {
      at,
      policyVersion: null,
      alerts: [
        {
          code: "no_ops_policy",
          severity: "critical",
          subject: tenantId,
          value: 0,
          limit: 1,
          detail: { message: "the tenant has no ops policy, so no threshold is known" },
        },
      ],
    };
  }
  const ctx: Ctx = { db, clock, tenantId, params: policy.params };
  const alerts: Alert[] = [];
  for (const check of ALL) alerts.push(...(await check(ctx)));
  return { at, policyVersion: policy.version, alerts };
}
