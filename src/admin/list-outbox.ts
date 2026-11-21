import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { idCursor, oneOf, pageOf, parseIdCursor } from "./paging.ts";

const STATES = ["due", "waiting", "dead", "done"] as const;

/** done / dead / due (not done, not dead, run_at has come) / waiting (not done, not dead, run_at later). */
const STATE_SQL: Record<(typeof STATES)[number], (clock: string) => string> = {
  done: () => "done_at IS NOT NULL",
  dead: () => "dead_at IS NOT NULL",
  due: (c) => `done_at IS NULL AND dead_at IS NULL AND run_at <= ${c}`,
  waiting: (c) => `done_at IS NULL AND dead_at IS NULL AND run_at > ${c}`,
};

export interface OutboxItem {
  id: number;
  kind: string;
  refId: string;
  runAt: string;
  attempts: number;
  lastError: string | null;
  doneAt: string | null;
  deadAt: string | null;
  cursor: string;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export async function listOutbox(
  db: Pick<Db, "query">,
  clock: Clock,
  tenantId: string,
  query: { state?: unknown; before?: unknown },
  limit: number,
) {
  const state = oneOf(query.state, STATES, "state");
  const after = parseIdCursor(query.before);
  const params: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  // The clock is a parameter only for the two states that compare run_at with it.
  if (state === "due" || state === "waiting") where.push(STATE_SQL[state](`$${params.push(clock.now())}`));
  else if (state) where.push(STATE_SQL[state](""));
  if (after !== null) where.push(`id < $${params.push(after)}`);
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT id, kind, ref_id, run_at, attempts, last_error, done_at, dead_at FROM outbox
      WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const items: OutboxItem[] = rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    refId: r.ref_id,
    runAt: new Date(r.run_at).toISOString(),
    attempts: r.attempts,
    lastError: r.last_error,
    doneAt: iso(r.done_at),
    deadAt: iso(r.dead_at),
    cursor: idCursor(r.id),
  }));
  return pageOf(items, limit);
}
