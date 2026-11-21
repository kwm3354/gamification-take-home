/**
 * The life of a redemption: a player spends coins, the casino platform issues a reward.
 *
 * Two opposite rules, for two opposite risks:
 *  - A call to the platform that issues a reward may be repeated ONLY after looking. Platform B has
 *    no idempotency key, so a blind repeat can grant twice. The "submitting" step always runs
 *    findReward first.
 *  - A ledger step (reserve, capture, release) may be repeated freely. Its transfer id comes from the
 *    redemption id, so a repeat moves nothing. We call the ledger BEFORE we write the new status.
 *
 * An unknown outcome (timeout, 5xx, 429) is never "refused". The redemption stays "submitting",
 * which the player and the operator can see, until a look at the platform says what happened.
 */
import type pg from "pg";
import { type AuditContext, create, record, update } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";
import {
  PlatformUnreachable,
  type Platforms,
  type RewardOutcome,
  type RewardRequest,
} from "../domain/casino-platform.ts";
import { type CoinLedger, LedgerUnavailable } from "../domain/coin-ledger.ts";
import type { Log } from "../logging/log.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { type Tenant, findTenant } from "../tenants/tenants.ts";

export const JOB_KIND = "redemption_advance";
const PENDING_RETRY_MS = 2000;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const INLINE_MAX_STEPS = 5;

export type RedemptionStatus = "created" | "reserved" | "submitting" | "issued" | "refused" | "insufficient";

/** A redemption row as PostgreSQL returns it (bigint as string). */
export interface RedemptionRow {
  id: string;
  tenant_id: string;
  player_id: string;
  idempotency_key: string;
  item_id: string;
  cost_coins: string;
  reward: { type: "bonus"; amountMinor: number; currency: string };
  status: RedemptionStatus;
  platform_ref: string | null;
  reason: string | null;
  settled_at: Date | null;
}

export interface RedemptionView {
  id: string;
  status: RedemptionStatus;
  costCoins: string;
  reward: RedemptionRow["reward"];
  reason: string | null;
  platformRef: string | null;
  settled: boolean;
}

export const toView = (r: RedemptionRow): RedemptionView => ({
  id: r.id,
  status: r.status,
  costCoins: String(r.cost_coins),
  reward: r.reward,
  reason: r.reason,
  platformRef: r.platform_ref,
  settled: r.settled_at !== null,
});

/** What one call of `advance` tells the caller. */
export type Step = "done" | "again" | { retryInMs: number };

/** At most `size` jobs hold a database connection for their whole run, so the pool is never used up by waiters. */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export interface StoreDeps {
  db: Db;
  clock: Clock;
  coins: CoinLedger;
  outbox: Outbox;
  platforms: Platforms;
  platformTimeoutMs: number;
  slots: Slots;
  /** Optional so that code which builds the deps by hand keeps working. */
  log?: Log;
}

export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.min(attempts, 20), BACKOFF_MAX_MS);

const ctxFor = (deps: Pick<StoreDeps, "clock">, tenantId: string, actor: string): AuditContext => ({
  tenantId,
  actor,
  now: deps.clock.now(),
});

interface Work {
  row: RedemptionRow;
  tenant: Tenant;
  externalPlayerId: string;
}

async function loadWork(deps: StoreDeps, id: string): Promise<Work | null> {
  const { rows } = await deps.db.query(
    "SELECT r.*, p.external_id FROM redemptions r JOIN players p ON p.id = r.player_id WHERE r.id = $1",
    [id],
  );
  const found = rows[0];
  if (!found) return null;
  const tenant = await findTenant(deps.db, found.tenant_id);
  if (!tenant) return null;
  const { external_id, ...row } = found;
  return { row: row as RedemptionRow, tenant, externalPlayerId: external_id };
}

/** One redemption of this tenant, or null. A malformed id is simply not found. */
export async function findRedemption(
  db: Pick<Db, "query">,
  tenantId: string,
  id: string,
  playerId?: string,
): Promise<RedemptionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(
    "SELECT * FROM redemptions WHERE id = $1 AND tenant_id = $2 AND ($3::uuid IS NULL OR player_id = $3)",
    [id, tenantId, playerId ?? null],
  );
  return (rows[0] as RedemptionRow | undefined) ?? null;
}

/** Creates the intent and its job in one transaction. A repeated key returns the first redemption. */
export async function createRedemption(
  deps: StoreDeps,
  input: {
    tenantId: string;
    playerId: string;
    idempotencyKey: string;
    itemId: string;
    actor: string;
    requestId?: string;
  },
): Promise<{ row: RedemptionRow; created: boolean } | "unknown_item"> {
  const existing = () =>
    deps.db
      .query("SELECT * FROM redemptions WHERE tenant_id = $1 AND player_id = $2 AND idempotency_key = $3", [
        input.tenantId,
        input.playerId,
        input.idempotencyKey,
      ])
      .then((r) => r.rows[0] as RedemptionRow | undefined);

  // A repeat answers with what was stored, whatever item the body names this time.
  const first = await existing();
  if (first) return { row: first, created: false };

  const item = /^[0-9a-f-]{36}$/i.test(input.itemId)
    ? (
        await deps.db.query(
          "SELECT id, cost_coins, reward FROM store_items WHERE id = $1 AND tenant_id = $2 AND active",
          [input.itemId, input.tenantId],
        )
      ).rows[0]
    : undefined;
  if (!item) return "unknown_item";

  const now = deps.clock.now();
  const ctx = { ...ctxFor(deps, input.tenantId, input.actor), requestId: input.requestId };
  const row = await transaction(deps.db, async (tx) => {
    const made = (await create(
      tx,
      ctx,
      "redemptions",
      {
        tenant_id: input.tenantId,
        player_id: input.playerId,
        idempotency_key: input.idempotencyKey,
        item_id: item.id,
        cost_coins: item.cost_coins,
        reward: item.reward,
        status: "created",
        created_at: now,
        updated_at: now,
      },
      { onConflict: "nothing" },
    )) as RedemptionRow | null;
    if (made) await deps.outbox.enqueue(tx, { tenantId: input.tenantId, kind: JOB_KIND, refId: made.id });
    return made;
  });
  if (row) {
    deps.log?.event("info", "redemption.created", {
      tenantId: input.tenantId,
      redemptionId: row.id,
      playerId: input.playerId,
      costCoins: String(row.cost_coins),
    });
    return { row, created: true };
  }
  // Another request with the same key won the race. Its row is committed by now.
  const winner = await existing();
  if (!winner) throw new Error("redemption vanished after a key conflict");
  return { row: winner, created: false };
}

/**
 * Makes a redemption final. It acts only when the status is "submitting"; any other call changes
 * nothing. `rearm` writes the job again so the ledger settles soon; a caller that is itself running
 * the job must pass false (the job row is locked by that very run) and return "again" instead.
 * The job row is touched first, then the redemption row: the same order the job runner uses.
 */
export async function confirm(
  deps: Pick<StoreDeps, "db" | "clock" | "outbox" | "log">,
  tenantId: string,
  redemptionId: string,
  outcome: Extract<RewardOutcome, { kind: "issued" | "refused" }>,
  actor: string,
  options: {
    rearm: boolean;
    onApplied?: (tx: pg.PoolClient) => Promise<void>;
    /** False for an admin's decision: losing a race to the platform is not a contradiction by the platform. */
    recordContradiction?: boolean;
  },
): Promise<boolean> {
  const ctx = ctxFor(deps, tenantId, actor);
  // What happened, written to the log only after the transaction has committed.
  let contradicted: { final: string; late: string } | undefined;
  const applied = await transaction(deps.db, async (tx) => {
    if (options.rearm) await deps.outbox.enqueue(tx, { tenantId, kind: JOB_KIND, refId: redemptionId });
    const seen: { status?: string } = {};
    const changed = await update(tx, ctx, "redemptions", redemptionId, (cur) => {
      seen.status = String(cur.status);
      if (cur.status !== "submitting") return null;
      return outcome.kind === "issued"
        ? { status: "issued", platform_ref: outcome.platformRef, updated_at: ctx.now }
        : { status: "refused", reason: outcome.reason, updated_at: ctx.now };
    });
    if (changed) {
      await options.onApplied?.(tx); // same transaction: it commits with the status change or not at all
      return true;
    }
    // A late answer that disagrees with the final status changes nothing but is written down.
    // The row is still locked here, so the status we saw is the status the record names.
    if (
      options.recordContradiction !== false &&
      (seen.status === "issued" || seen.status === "refused") &&
      seen.status !== outcome.kind
    ) {
      await record(tx, ctx, {
        action: "outcome_contradicted",
        entityType: "redemption",
        entityId: redemptionId,
        changes: {
          final: seen.status,
          late: outcome.kind,
          ...(outcome.kind === "issued" ? { platformRef: outcome.platformRef } : { reason: outcome.reason }),
        },
      });
      contradicted = { final: seen.status, late: outcome.kind };
    }
    return false;
  });
  if (applied) {
    deps.log?.event("info", "redemption.status", {
      tenantId,
      redemptionId,
      from: "submitting",
      to: outcome.kind,
      ...(outcome.kind === "refused" ? { reason: outcome.reason } : {}),
    });
  } else if (contradicted) {
    deps.log?.event("warn", "redemption.contradicted", { tenantId, redemptionId, ...contradicted });
  }
  return applied;
}

/** A message from the platform (platform B's webhook). Returns the redemption as it is afterwards. */
export async function applyNotice(
  deps: StoreDeps,
  tenantId: string,
  notice: { redemptionId: string; outcome: RewardOutcome },
  actor: string,
): Promise<RedemptionRow | null> {
  const row = await findRedemption(deps.db, tenantId, notice.redemptionId);
  if (!row) return null;
  const outcome = notice.outcome;
  if (
    outcome.kind === "pending" ||
    row.status === "created" ||
    row.status === "reserved" ||
    row.status === "insufficient"
  ) {
    // We have not called the platform for this redemption, so the notice cannot be about our request.
    await transaction(deps.db, (tx) =>
      record(tx, ctxFor(deps, tenantId, actor), {
        action: "reward_notice_ignored",
        entityType: "redemption",
        entityId: row.id,
        changes: { status: row.status, notice: notice.outcome.kind },
      }),
    );
    return row;
  }
  await confirm(deps, tenantId, row.id, outcome, actor, { rearm: true });
  return findRedemption(deps.db, tenantId, row.id);
}

/** Runs a platform call and writes it to the audit trail, whatever came back. */
async function observed<T extends RewardOutcome | "not_found">(
  deps: StoreDeps,
  w: Work,
  opts: StepOptions,
  call: "issue" | "find",
  run: () => Promise<T>,
): Promise<T> {
  const actor = opts.actor;
  const started = deps.clock.now().getTime();
  const ms = () => deps.clock.now().getTime() - started;
  const fact = (changes: unknown) =>
    transaction(deps.db, (tx) =>
      record(tx, ctxFor(deps, w.tenant.id, actor), {
        action: "platform_call",
        entityType: "redemption",
        entityId: w.row.id,
        changes,
      }),
    );
  let result: T;
  try {
    result = await run();
  } catch (e) {
    if (e instanceof PlatformUnreachable) {
      await fact({ call, error: e.message });
      deps.log?.event("warn", "platform.unreachable", {
        tenantId: w.tenant.id,
        redemptionId: w.row.id,
        call,
        error: e.message,
        retryInMs: retryAfter(e, opts.attempts),
        ms: ms(),
      });
    }
    throw e;
  }
  deps.log?.event("info", "platform.call", {
    tenantId: w.tenant.id,
    redemptionId: w.row.id,
    call,
    outcome: result === "not_found" ? "not_found" : result.kind,
    ms: ms(),
  });
  await fact({
    call,
    outcome: result === "not_found" ? "not_found" : result.kind,
    ...(result !== "not_found" && result.kind === "refused" ? { reason: result.reason } : {}),
  });
  return result;
}

/** How long to wait after an unreachable platform: what it asked for, or the backoff. */
const retryAfter = (e: PlatformUnreachable, attempts: number): number =>
  e.retryAfterMs ?? backoffMs(attempts);

async function submittingStep(deps: StoreDeps, w: Work, opts: StepOptions): Promise<Step> {
  const platform = deps.platforms.for(w.tenant.platform);
  const conn = {
    tenantId: w.tenant.id,
    platformUrl: w.tenant.platformUrl,
    platformKey: w.tenant.platformKey,
    webhookSecret: w.tenant.webhookSecret,
    timeoutMs: deps.platformTimeoutMs,
  };
  const request: RewardRequest = {
    redemptionId: w.row.id,
    externalPlayerId: w.externalPlayerId,
    reward: w.row.reward,
  };
  try {
    // Look first, always. Only "the platform has never heard of it" allows a call that issues.
    const found = await observed(deps, w, opts, "find", () => platform.findReward(conn, w.row.id));
    const outcome =
      found === "not_found"
        ? await observed(deps, w, opts, "issue", () => platform.issueReward(conn, request))
        : found;
    if (outcome.kind === "pending") {
      const ref = outcome.platformRef;
      if (ref) {
        const ctx = ctxFor(deps, w.tenant.id, opts.actor);
        await transaction(deps.db, (tx) =>
          update(tx, ctx, "redemptions", w.row.id, (cur) =>
            cur.status === "submitting" && cur.platform_ref !== ref
              ? { platform_ref: ref, updated_at: ctx.now }
              : null,
          ),
        );
      }
      return { retryInMs: PENDING_RETRY_MS };
    }
    await confirm(deps, w.tenant.id, w.row.id, outcome, opts.actor, { rearm: false });
    return "again";
  } catch (e) {
    if (e instanceof PlatformUnreachable) return { retryInMs: retryAfter(e, opts.attempts) };
    throw e;
  }
}

export interface StepOptions {
  /** How many earlier runs of this job asked to wait. Drives the backoff. */
  attempts: number;
  actor: string;
}

/**
 * One step, as in docs/contracts.md. Safe to call again at any time and from any state:
 * the state check happens inside `update`, under the row lock.
 */
export async function advance(deps: StoreDeps, redemptionId: string, opts: StepOptions): Promise<Step> {
  const w = await loadWork(deps, redemptionId);
  if (!w) return "done";
  const { row, tenant } = w;
  const ctx = ctxFor(deps, tenant.id, opts.actor);
  const move = async (from: RedemptionStatus, to: RedemptionStatus) => {
    const changed = await transaction(deps.db, (tx) =>
      update(tx, ctx, "redemptions", row.id, (cur) =>
        cur.status === from
          ? {
              status: to,
              updated_at: ctx.now,
              // "insufficient" reserved nothing, so there is nothing left to settle.
              ...(to === "insufficient" ? { settled_at: ctx.now } : {}),
            }
          : null,
      ),
    );
    if (changed)
      deps.log?.event("info", "redemption.status", { tenantId: tenant.id, redemptionId: row.id, from, to });
  };
  const settle = async (from: RedemptionStatus) => {
    const changed = await transaction(deps.db, (tx) =>
      update(tx, ctx, "redemptions", row.id, (cur) =>
        cur.settled_at === null ? { settled_at: ctx.now, updated_at: ctx.now } : null,
      ),
    );
    if (changed) {
      deps.log?.event("info", "redemption.status", {
        tenantId: tenant.id,
        redemptionId: row.id,
        from,
        to: "settled",
      });
    }
  };

  switch (row.status) {
    case "created": {
      // Ledger first, status second. A crash in between repeats the reserve with the same id.
      const reserved = await deps.coins.reserve({
        ledgerNo: tenant.ledgerNo,
        playerId: row.player_id,
        redemptionId: row.id,
        coins: BigInt(row.cost_coins),
      });
      await move("created", reserved === "reserved" ? "reserved" : "insufficient");
      return reserved === "reserved" ? "again" : "done";
    }
    case "reserved":
      await move("reserved", "submitting"); // committed before any call to the platform
      return "again";
    case "submitting":
      return submittingStep(deps, w, opts);
    case "issued":
      if (row.settled_at) return "done";
      await deps.coins.capture({ ledgerNo: tenant.ledgerNo, redemptionId: row.id });
      await settle("issued");
      return "done";
    case "refused":
      if (row.settled_at) return "done";
      await deps.coins.release({ ledgerNo: tenant.ledgerNo, redemptionId: row.id });
      await settle("refused");
      return "done";
    default:
      return "done"; // insufficient: final, nothing was reserved
  }
}

/** `advance`, with a ledger that does not answer turned into "ask again later" (it is never a reason to give up). */
export async function step(deps: StoreDeps, redemptionId: string, opts: StepOptions): Promise<Step> {
  try {
    return await advance(deps, redemptionId, opts);
  } catch (e) {
    if (e instanceof LedgerUnavailable) return { retryInMs: backoffMs(opts.attempts) };
    throw e;
  }
}

/**
 * Runs the redemption's own job now, for the request that created or changed it. It takes the same
 * row lock the outbox runner takes (FOR UPDATE SKIP LOCKED on the job row), so the timer and this
 * request never run the same redemption at the same time. If someone else holds the lock, it does
 * nothing: that run will do the work. It writes the job row like the runner would.
 */
export async function runInline(
  deps: StoreDeps,
  redemptionId: string,
  actor: string,
  maxSteps = INLINE_MAX_STEPS,
): Promise<void> {
  await deps.slots.run(() =>
    transaction(deps.db, async (tx: pg.PoolClient) => {
      const { rows } = await tx.query(
        "SELECT id, tenant_id, attempts FROM outbox WHERE kind = $1 AND ref_id = $2 FOR UPDATE SKIP LOCKED",
        [JOB_KIND, redemptionId],
      );
      const job = rows[0];
      if (!job) return; // busy, or no job
      let result: Step | { error: string } = "again";
      try {
        for (let i = 0; i < maxSteps && result === "again"; i++) {
          result = await step(deps, redemptionId, { attempts: job.attempts, actor });
        }
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const now = deps.clock.now();
      const later = (ms: number) => new Date(now.getTime() + ms);
      if (result === "done") {
        await tx.query("UPDATE outbox SET done_at = $2, last_error = NULL WHERE id = $1", [job.id, now]);
      } else if (typeof result === "object" && "retryInMs" in result) {
        await tx.query("UPDATE outbox SET run_at = $2, attempts = attempts + 1 WHERE id = $1", [
          job.id,
          later(result.retryInMs),
        ]);
        deps.log?.event("debug", "outbox.retry", {
          tenantId: job.tenant_id,
          kind: JOB_KIND,
          refId: redemptionId,
          attempts: job.attempts + 1,
          retryInMs: result.retryInMs,
        });
      } else if (typeof result === "object") {
        await tx.query(
          "UPDATE outbox SET run_at = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1",
          [job.id, later(backoffMs(job.attempts)), result.error],
        );
        deps.log?.event("debug", "outbox.retry", {
          tenantId: job.tenant_id,
          kind: JOB_KIND,
          refId: redemptionId,
          attempts: job.attempts + 1,
          retryInMs: backoffMs(job.attempts),
          error: result.error,
        });
      }
      // "again" after the last step: the job stays due and the timer continues.
    }),
  );
}
