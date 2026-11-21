import type pg from "pg";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { type Log, withRequestId } from "../logging/log.ts";
import { span } from "../tracing/tracing.ts";

/** Injection token: `@Inject(OUTBOX) private readonly outbox: Outbox`. */
export const OUTBOX = Symbol("OUTBOX");

export interface OutboxJob {
  tenantId: string;
  kind: string;
  refId: string;
  runAt?: Date;
}

export interface RunningJob {
  tenantId: string;
  kind: string;
  refId: string;
  /** How many earlier runs failed or asked to wait. */
  attempts: number;
}

export type JobHandler = (job: RunningJob) => Promise<"done" | { retryInMs: number }>;

export type Outcome = "done" | { retryInMs: number } | { error: string };

/** A job a worker holds the lease on. Only the holder of `token` may write the outcome. */
export interface Claim {
  id: string;
  token: string;
  tenantId: string;
  kind: string;
  refId: string;
  attempts: number;
}

export interface OutboxOptions {
  /**
   * How long a claim lasts, in ms. It must be longer than the longest handler: the platform time
   * limit plus the ledger time limit (2 s each by default). A worker that dies leaves its claim;
   * the job is due again when the lease ends.
   */
  leaseMs?: number;
  /** How many jobs one claim takes. */
  batch?: number;
}

const MAX_ATTEMPTS = 10;
const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH = 16;

/**
 * A queue of work that must survive a crash, kept in PostgreSQL.
 *
 * No network call inside a database transaction. A worker claims jobs with one short statement
 * (FOR UPDATE SKIP LOCKED inside it) that sets `claimed_until` and a fresh `claim_token`. Then it
 * runs the handlers with no transaction open and no connection held. It writes the outcome with
 * `WHERE claim_token = ours`. If the lease ran out and another worker took the job, that write
 * matches nothing: the slow worker cannot overwrite the outcome of the one that took over.
 *
 * A job can run more than once across crashes and lease expiry: handlers must be safe to repeat.
 * Enqueueing a job that a worker holds does not touch the claim; it sets `rerun`, and the finish
 * of the running worker leaves the job due again. So a job never runs twice at the same time
 * unless a handler outlives its lease.
 */
export class Outbox {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly leaseMs: number;
  private readonly batch: number;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log?: Log,
    options: OutboxOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.batch = options.batch ?? DEFAULT_BATCH;
  }

  handle(kind: string, fn: JobHandler): void {
    this.handlers.set(kind, fn);
  }

  /**
   * Writes the job in the caller's transaction. Enqueueing again makes the job due and not done.
   * That includes a dead job: a new request is a legitimate reason to try again. It is never silent:
   * a revived dead job writes the warning `outbox.revived` with the error it died of.
   * If a worker holds the job, its claim is left alone and `rerun` is set (see the class comment).
   */
  async enqueue(tx: pg.PoolClient, job: OutboxJob): Promise<void> {
    // The CTE reads the row as it was before this statement changes it.
    const { rows } = await tx.query(
      `WITH before AS (SELECT dead_at, last_error FROM outbox WHERE kind = $2 AND ref_id = $3),
       upsert AS (
         INSERT INTO outbox (tenant_id, kind, ref_id, run_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, ref_id)
         DO UPDATE SET run_at = EXCLUDED.run_at, done_at = NULL, dead_at = NULL, attempts = 0,
                       rerun = (outbox.claim_token IS NOT NULL)
         RETURNING id)
       SELECT (SELECT dead_at FROM before) AS was_dead_at, (SELECT last_error FROM before) AS last_error
       FROM upsert`,
      [job.tenantId, job.kind, job.refId, job.runAt ?? this.clock.now()],
    );
    if (rows[0]?.was_dead_at) {
      this.log?.event("warn", "outbox.revived", {
        tenantId: job.tenantId,
        kind: job.kind,
        refId: job.refId,
        previousError: rows[0].last_error ?? null,
      });
    }
  }

  /**
   * Claims due jobs and runs their handlers at the same time, round after round, until nothing is
   * due. Returns how many ran.
   */
  async runDue(): Promise<number> {
    let ran = 0;
    for (;;) {
      const claims = await this.claimDue();
      if (claims.length === 0) return ran;
      await Promise.all(claims.map((c) => this.runClaimed(c)));
      ran += claims.length;
    }
  }

  /** Runs due jobs until none is left. For tests. */
  async drain(maxRounds = 20): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      if ((await this.runDue()) === 0) return;
    }
  }

  /**
   * Takes the lease on one job whatever its `run_at`, for a request that runs its own job. Null when
   * someone else holds a live lease: that worker will finish it. It never waits for anyone.
   */
  async claimOne(kind: string, refId: string): Promise<Claim | null> {
    const now = this.clock.now();
    const { rows } = await this.db.query(
      `UPDATE outbox SET claimed_until = $3, claim_token = gen_random_uuid(), rerun = false
       WHERE kind = $1 AND ref_id = $2 AND (claimed_until IS NULL OR claimed_until <= $4)
       RETURNING id, tenant_id, kind, ref_id, attempts, claim_token`,
      [kind, refId, new Date(now.getTime() + this.leaseMs), now],
    );
    return rows[0] ? toClaim(rows[0]) : null;
  }

  private async claimDue(): Promise<Claim[]> {
    const now = this.clock.now();
    const { rows } = await this.db.query(
      `UPDATE outbox SET claimed_until = $2, claim_token = gen_random_uuid(), rerun = false
       WHERE id IN (
         SELECT id FROM outbox
         WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= $1
           AND (claimed_until IS NULL OR claimed_until <= $1)
         ORDER BY run_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING id, tenant_id, kind, ref_id, attempts, claim_token`,
      [now, new Date(now.getTime() + this.leaseMs), this.batch],
    );
    return rows.map(toClaim);
  }

  private async runClaimed(claim: Claim): Promise<void> {
    const requestId = `job:${claim.kind}:${claim.refId}`;
    let outcome: Outcome;
    try {
      const handler = this.handlers.get(claim.kind);
      if (!handler) throw new Error(`no handler for ${claim.kind}`);
      const job: RunningJob = {
        tenantId: claim.tenantId,
        kind: claim.kind,
        refId: claim.refId,
        attempts: claim.attempts,
      };
      // Each run is a new trace of its own. Claiming the row is before it and is not traced.
      outcome = await span(
        `outbox ${claim.kind}`,
        { "tenant.id": claim.tenantId, "outbox.attempts": claim.attempts, "request.id": requestId },
        async (s) => {
          try {
            const result = await withRequestId(requestId, () => handler(job));
            s.setAttribute("outbox.result", result === "done" ? "done" : "retry");
            return result;
          } catch (e) {
            s.setAttribute("outbox.result", claim.attempts + 1 >= MAX_ATTEMPTS ? "dead" : "retry");
            throw e;
          }
        },
        { root: true },
      );
    } catch (e) {
      outcome = { error: e instanceof Error ? e.message : String(e) };
    }
    try {
      await this.finish(claim, outcome);
    } catch (e) {
      // The claim stays; the job is due again when the lease ends.
      this.log?.event("error", "unhandled", {
        where: "outbox_finish",
        kind: claim.kind,
        refId: claim.refId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Writes the outcome of a claimed job and clears the claim. The write is fenced: it matches only
   * while `claim_token` is still ours. Returns false when the lease was lost; nothing is written.
   * If the job was enqueued again while we held it (`rerun`), the outcome is not written and the
   * job stays due as that enqueue left it.
   */
  async finish(claim: Claim, outcome: Outcome): Promise<boolean> {
    const after = this.clock.now(); // the handler may have moved the clock
    const later = (ms: number) => new Date(after.getTime() + ms);
    const requestId = `job:${claim.kind}:${claim.refId}`;
    const release = "claimed_until = NULL, claim_token = NULL, rerun = false";
    let sql: string;
    let params: unknown[];
    let retryInMs: number | undefined;
    let dead = false;
    if (outcome === "done") {
      sql = `UPDATE outbox SET ${release},
               done_at = CASE WHEN rerun THEN done_at ELSE $3 END,
               last_error = CASE WHEN rerun THEN last_error ELSE NULL END
             WHERE id = $1 AND claim_token = $2`;
      params = [claim.id, claim.token, after];
    } else if ("retryInMs" in outcome) {
      // The platform has not decided yet. Never dead: it may take a long time.
      retryInMs = outcome.retryInMs;
      sql = `UPDATE outbox SET ${release},
               run_at = CASE WHEN rerun THEN run_at ELSE $3 END,
               attempts = CASE WHEN rerun THEN attempts ELSE attempts + 1 END
             WHERE id = $1 AND claim_token = $2`;
      params = [claim.id, claim.token, later(outcome.retryInMs)];
    } else if (claim.attempts + 1 >= MAX_ATTEMPTS) {
      dead = true;
      sql = `UPDATE outbox SET ${release},
               dead_at = CASE WHEN rerun THEN dead_at ELSE $3 END,
               attempts = CASE WHEN rerun THEN attempts ELSE attempts + 1 END,
               last_error = $4
             WHERE id = $1 AND claim_token = $2`;
      params = [claim.id, claim.token, after, outcome.error];
    } else {
      retryInMs = Math.min(FIRST_DELAY_MS * 2 ** claim.attempts, MAX_DELAY_MS);
      sql = `UPDATE outbox SET ${release},
               run_at = CASE WHEN rerun THEN run_at ELSE $3 END,
               attempts = CASE WHEN rerun THEN attempts ELSE attempts + 1 END,
               last_error = $4
             WHERE id = $1 AND claim_token = $2`;
      params = [claim.id, claim.token, later(retryInMs), outcome.error];
    }
    const { rowCount } = await this.db.query(sql, params);
    const where = { tenantId: claim.tenantId, kind: claim.kind, refId: claim.refId };
    if (rowCount === 0) {
      this.log?.event("warn", "outbox.lease_lost", where);
      return false;
    }
    if (dead) {
      this.log?.event("error", "outbox.dead", {
        ...where,
        requestId,
        attempts: claim.attempts + 1,
        lastError: (outcome as { error: string }).error,
      });
    } else if (retryInMs !== undefined) {
      this.log?.event("debug", "outbox.retry", {
        ...where,
        requestId,
        attempts: claim.attempts + 1,
        retryInMs,
        ...(typeof outcome === "object" && "error" in outcome ? { error: outcome.error } : {}),
      });
    }
    return true;
  }
}

function toClaim(r: Record<string, unknown>): Claim {
  return {
    id: String(r.id),
    token: String(r.claim_token),
    tenantId: String(r.tenant_id),
    kind: String(r.kind),
    refId: String(r.ref_id),
    attempts: Number(r.attempts),
  };
}
