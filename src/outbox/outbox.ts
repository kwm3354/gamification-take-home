import type pg from "pg";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";

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

const MAX_ATTEMPTS = 10;
const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

/**
 * A queue of work that must survive a crash, kept in PostgreSQL.
 *
 * A job is claimed with FOR UPDATE SKIP LOCKED and its handler runs while the row lock is held, so
 * two workers never run the same job at the same time. If the process dies, the lock goes with the
 * connection and the job is due again. A job can therefore run more than once across crashes:
 * handlers must be safe to repeat.
 */
export class Outbox {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  handle(kind: string, fn: JobHandler): void {
    this.handlers.set(kind, fn);
  }

  /** Writes the job in the caller's transaction. Enqueueing again makes the job due and not done. */
  async enqueue(tx: pg.PoolClient, job: OutboxJob): Promise<void> {
    await tx.query(
      `INSERT INTO outbox (tenant_id, kind, ref_id, run_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, ref_id)
       DO UPDATE SET run_at = EXCLUDED.run_at, done_at = NULL, dead_at = NULL, attempts = 0`,
      [job.tenantId, job.kind, job.refId, job.runAt ?? this.clock.now()],
    );
  }

  /** Runs every job that is due now, one after the other. Returns how many ran. */
  async runDue(): Promise<number> {
    let ran = 0;
    while (await this.runOne()) ran++;
    return ran;
  }

  /** Runs due jobs until none is left. For tests. */
  async drain(maxRounds = 20): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      if ((await this.runDue()) === 0) return;
    }
  }

  private runOne(): Promise<boolean> {
    return transaction(this.db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, tenant_id, kind, ref_id, attempts FROM outbox
         WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= $1
         ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [this.clock.now()],
      );
      const row = rows[0];
      if (!row) return false;
      const job: RunningJob = {
        tenantId: row.tenant_id,
        kind: row.kind,
        refId: row.ref_id,
        attempts: row.attempts,
      };

      let outcome: "done" | { retryInMs: number } | { error: string };
      try {
        const handler = this.handlers.get(job.kind);
        if (!handler) throw new Error(`no handler for ${job.kind}`);
        outcome = await handler(job);
      } catch (e) {
        outcome = { error: e instanceof Error ? e.message : String(e) };
      }

      const after = this.clock.now(); // the handler may have moved the clock
      const later = (ms: number) => new Date(after.getTime() + ms);
      if (outcome === "done") {
        await tx.query("UPDATE outbox SET done_at = $2, last_error = NULL WHERE id = $1", [row.id, after]);
      } else if ("retryInMs" in outcome) {
        // The platform has not decided yet. Never dead: it may take a long time.
        await tx.query("UPDATE outbox SET run_at = $2, attempts = attempts + 1 WHERE id = $1", [
          row.id,
          later(outcome.retryInMs),
        ]);
      } else if (job.attempts + 1 >= MAX_ATTEMPTS) {
        await tx.query(
          "UPDATE outbox SET dead_at = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1",
          [row.id, after, outcome.error],
        );
      } else {
        const delay = Math.min(FIRST_DELAY_MS * 2 ** job.attempts, MAX_DELAY_MS);
        await tx.query(
          "UPDATE outbox SET run_at = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1",
          [row.id, later(delay), outcome.error],
        );
      }
      return true;
    });
  }
}
