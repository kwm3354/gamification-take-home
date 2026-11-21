import { record } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { type RedemptionRow, confirm, findRedemption } from "../store/redemption.ts";

export type ManualOutcome = "issued" | "refused";

export type Resolution =
  | { kind: "not_found" }
  | { kind: "conflict"; row: RedemptionRow }
  | { kind: "resolved"; row: RedemptionRow };

/**
 * An admin decides the outcome of a redemption whose answer cannot be learned. It goes through
 * the same `confirm` as the platform's answers, so the same rules hold: only a `submitting`
 * redemption changes, under the row lock, and the job that settles the ledger is queued. The
 * audit record "manual_resolution" is written in confirm's own transaction and only when this
 * call is the one that made the redemption final.
 * `settle` (optional) runs the ledger step at once; without it the outbox job does it.
 */
export async function resolveRedemption(
  deps: { db: Db; clock: Clock; outbox: Outbox },
  tenantId: string,
  redemptionId: string,
  input: { outcome: ManualOutcome; note: string },
  actor: string,
  settle?: (redemptionId: string, actor: string) => Promise<void>,
): Promise<Resolution> {
  const row = await findRedemption(deps.db, tenantId, redemptionId);
  if (!row) return { kind: "not_found" };
  if (row.status !== "submitting") return { kind: "conflict", row };

  const now = deps.clock.now();
  const applied = await confirm(
    deps,
    tenantId,
    redemptionId,
    input.outcome === "issued"
      ? { kind: "issued", platformRef: "manual" }
      : { kind: "refused", reason: `manual: ${input.note}` },
    actor,
    {
      rearm: true,
      recordContradiction: false,
      onApplied: (tx) =>
        record(
          tx,
          { tenantId, actor, now },
          {
            action: "manual_resolution",
            entityType: "redemption",
            entityId: redemptionId,
            changes: { outcome: input.outcome, note: input.note },
          },
        ),
    },
  );
  const after = (await findRedemption(deps.db, tenantId, redemptionId)) ?? row;
  if (!applied) return { kind: "conflict", row: after }; // someone else made it final first
  if (settle) await settle(redemptionId, actor);
  const settled = (await findRedemption(deps.db, tenantId, redemptionId)) ?? after;
  return { kind: "resolved", row: settled };
}
