import type pg from "pg";
import { expectedPrizeAbove, expectedPrizeCoins } from "../alerts/alerts.ts";
import { loadOpsPolicy } from "../alerts/ops-policy.ts";
import { type AuditContext, create, update } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";
import { BadQuery } from "./paging.ts";
import { changeView } from "./settings.ts";

/**
 * A change of the wheel is an intent. The casino's admin proposes it; the newest ops policy decides
 * whether it is applied at once (expected prize within the limit) or waits for the platform admin.
 * Plain code: everything for one call happens in one transaction with the change row.
 *
 * Locks, always in this order: the change row, then the tenant row. The tenant row lock makes
 * "next version = max + 1" safe when two changes are applied at once; the unique key
 * (tenant_id, version) is the backstop. The lock is FOR NO KEY UPDATE, not FOR UPDATE: inserting
 * a row that points at the tenant (foreign key) takes a weaker lock on it, and FOR UPDATE would
 * deadlock against that.
 */
export interface WheelSegment {
  label: string;
  coins: number;
  weight: number;
}

export type ChangeView = ReturnType<typeof changeView>;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The rules of the contract. Extra fields are dropped. Throws BadQuery with the reason. */
export function validateSegments(input: unknown): WheelSegment[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 24) {
    throw new BadQuery("segments must be a list of 2 to 24 items");
  }
  return input.map((raw, i) => {
    const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof s.label !== "string" || s.label.length < 1 || s.label.length > 40) {
      throw new BadQuery(`segment ${i}: label must be 1 to 40 characters`);
    }
    if (!isInt(s.coins, 1, 1_000_000))
      throw new BadQuery(`segment ${i}: coins must be an integer 1 to 1000000`);
    if (!isInt(s.weight, 1, 1_000_000))
      throw new BadQuery(`segment ${i}: weight must be an integer 1 to 1000000`);
    return { label: s.label, coins: s.coins, weight: s.weight };
  });
}

/** Creates wheel version max + 1 for the tenant, under the tenant row lock. Returns the new row. */
async function addWheelVersion(
  tx: pg.PoolClient,
  ctx: AuditContext,
  tenantId: string,
  segments: WheelSegment[],
): Promise<{ id: string; version: number }> {
  await tx.query("SELECT 1 FROM tenants WHERE id = $1 FOR NO KEY UPDATE", [tenantId]);
  const next = await tx.query(
    "SELECT coalesce(max(version), 0) + 1 AS v FROM wheel_configs WHERE tenant_id = $1",
    [tenantId],
  );
  const row = await create(tx, ctx, "wheel_configs", {
    tenant_id: tenantId,
    version: next.rows[0].v,
    segments,
  });
  return { id: row?.id as string, version: row?.version as number };
}

export type ProposeResult =
  | { kind: "applied"; change: ChangeView; wheelVersion: number }
  | { kind: "proposed"; change: ChangeView }
  | { kind: "no_policy" };

export async function proposeWheelChange(
  deps: { db: Db; clock: Clock },
  adminId: string,
  tenantId: string,
  segments: WheelSegment[],
): Promise<ProposeResult> {
  return transaction(deps.db, async (tx) => {
    const now = deps.clock.now();
    const policy = await loadOpsPolicy(tx, tenantId);
    if (!policy) return { kind: "no_policy" };
    const limit = policy.params.maxExpectedPrizeCoins;
    const person: AuditContext = { tenantId, actor: `admin/${adminId}`, now };
    const created = await create(tx, person, "settings_changes", {
      tenant_id: tenantId,
      kind: "wheel_config",
      proposed: { segments },
      status: "proposed",
      expected_prize_coins: expectedPrizeCoins(segments),
      limit_coins: limit,
      proposed_by: person.actor,
      created_at: now,
    });
    const id = created?.id as string;
    if (expectedPrizeAbove(segments, limit)) return { kind: "proposed", change: changeView(created) };

    // Within the limit: the policy applies it now, and the audit rows name the policy.
    const decider = `policy/ops-v${policy.version}`;
    const byPolicy: AuditContext = { tenantId, actor: decider, now };
    const wheel = await addWheelVersion(tx, byPolicy, tenantId, segments);
    const done = await update(tx, byPolicy, "settings_changes", id, () => ({
      status: "applied",
      decided_by: decider,
      decision_note: `within the limit of ${limit} coins`,
      result_id: wheel.id,
      decided_at: now,
    }));
    return { kind: "applied", change: changeView(done?.after), wheelVersion: wheel.version };
  });
}

export type DecideResult =
  | { kind: "applied"; change: ChangeView; wheelVersion: number }
  | { kind: "rejected"; change: ChangeView }
  | { kind: "not_found" }
  | { kind: "conflict" };

/** The platform admin approves or rejects a waiting change. A change that is no longer waiting is a conflict. */
export async function decideChange(
  deps: { db: Db; clock: Clock },
  adminId: string,
  id: string,
  decision: "approve" | "reject",
  note: string,
): Promise<DecideResult> {
  return transaction(deps.db, async (tx) => {
    const now = deps.clock.now();
    // Lock the change first; the second of two approvals waits here and then sees "applied".
    const found = await tx.query("SELECT * FROM settings_changes WHERE id = $1 FOR UPDATE", [id]);
    const current = found.rows[0];
    if (!current) return { kind: "not_found" };
    if (current.status !== "proposed") return { kind: "conflict" };
    const ctx: AuditContext = { tenantId: current.tenant_id, actor: `admin/${adminId}`, now };

    if (decision === "reject") {
      const done = await update(tx, ctx, "settings_changes", id, (row) =>
        row.status === "proposed"
          ? { status: "rejected", decided_by: ctx.actor, decision_note: note, decided_at: now }
          : null,
      );
      return done ? { kind: "rejected", change: changeView(done.after) } : { kind: "conflict" };
    }

    const wheel = await addWheelVersion(tx, ctx, current.tenant_id, current.proposed.segments);
    const done = await update(tx, ctx, "settings_changes", id, (row) =>
      row.status === "proposed"
        ? {
            status: "applied",
            decided_by: ctx.actor,
            decision_note: note,
            result_id: wheel.id,
            decided_at: now,
          }
        : null,
    );
    if (!done) throw new Error("the change was decided while locked"); // cannot happen under the lock
    return { kind: "applied", change: changeView(done.after), wheelVersion: wheel.version };
  });
}

export async function waitingChanges(db: Pick<Db, "query">, status: "proposed" | "applied" | "rejected") {
  const { rows } = await db.query(
    "SELECT * FROM settings_changes WHERE status = $1 ORDER BY created_at, id",
    [status],
  );
  return rows.map(changeView);
}
