import { type Row, update } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";
import type { CoinLedger } from "../domain/coin-ledger.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { findTenant } from "../tenants/tenants.ts";
import { type Segment, pickSegment } from "./pick-segment.ts";

export interface SpinResult {
  spinId: string;
  segmentIndex: number;
  label: string;
  coins: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Using a spin and crediting its prize. Two steps with two stores and no shared transaction:
 * 1. PostgreSQL, one transaction: spin available -> used, with the outcome, plus the job.
 * 2. TigerBeetle, transfer id derived from the spin id (safe to repeat), then credited_at.
 * A crash between the steps is repaired by the job running step 2 again.
 */
export class SpinService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly coins: CoinLedger,
    private readonly outbox: Outbox,
  ) {}

  /** The spin of this player, or null. Never says whether a spin of someone else exists. */
  private async find(tenantId: string, playerId: string, spinId: string): Promise<Row | null> {
    if (!UUID.test(spinId)) return null;
    const r = await this.db.query("SELECT * FROM spins WHERE id = $1 AND tenant_id = $2 AND player_id = $3", [
      spinId,
      tenantId,
      playerId,
    ]);
    return (r.rows[0] as Row | undefined) ?? null;
  }

  private async segments(configId: string): Promise<Segment[]> {
    const r = await this.db.query("SELECT segments FROM wheel_configs WHERE id = $1", [configId]);
    return r.rows[0].segments as Segment[];
  }

  private resultOf(spin: Row, segments: Segment[]): SpinResult {
    const index = spin.segment_index as number;
    const segment = segments[index] as Segment;
    return {
      spinId: spin.id as string,
      segmentIndex: index,
      label: segment.label,
      coins: Number(spin.coins),
    };
  }

  /** Returns null when this player has no such spin. `fresh` is true only for the call that used it. */
  async spin(
    tenant: { id: string; wheelSecret: string },
    playerId: string,
    spinId: string,
    requestId: string,
  ): Promise<{ result: SpinResult; fresh: boolean } | null> {
    const spin = await this.find(tenant.id, playerId, spinId);
    if (!spin) return null;
    const segments = await this.segments(spin.wheel_config_id as string);

    if (spin.status === "available") {
      const index = pickSegment(tenant.wheelSecret, spinId, segments);
      const now = this.clock.now();
      const won = await transaction(this.db, async (tx) => {
        const changed = await update(
          tx,
          { tenantId: tenant.id, actor: `player/${playerId}`, requestId, now },
          "spins",
          spinId,
          (cur) =>
            cur.tenant_id === tenant.id && cur.player_id === playerId && cur.status === "available"
              ? {
                  status: "used",
                  segment_index: index,
                  coins: (segments[index] as Segment).coins,
                  used_at: now,
                }
              : null,
        );
        if (!changed) return null;
        await this.outbox.enqueue(tx, { tenantId: tenant.id, kind: "spin_credit", refId: spinId });
        return changed.after;
      });
      if (won) return { result: this.resultOf(won, segments), fresh: true };
    }

    // Someone else used it first, or it was used before: return the stored result.
    const used = await this.find(tenant.id, playerId, spinId);
    if (!used || used.status !== "used") return null;
    if (!used.credited_at) {
      await transaction(this.db, (tx) =>
        this.outbox.enqueue(tx, { tenantId: tenant.id, kind: "spin_credit", refId: spinId }),
      );
    }
    return { result: this.resultOf(used, segments), fresh: false };
  }

  /** The outbox step. Safe to repeat: the transfer id comes from the spin id. */
  async creditSpin(spinId: string): Promise<void> {
    const r = await this.db.query("SELECT * FROM spins WHERE id = $1", [spinId]);
    const spin = r.rows[0] as Row | undefined;
    if (!spin || spin.credited_at) return;
    const tenant = await findTenant(this.db, spin.tenant_id as string);
    if (!tenant) throw new Error(`tenant ${String(spin.tenant_id)} not found`);
    await this.coins.creditPrize({
      ledgerNo: tenant.ledgerNo,
      playerId: spin.player_id as string,
      spinId,
      coins: BigInt(spin.coins as string),
    });
    const now = this.clock.now();
    await transaction(this.db, (tx) =>
      update(tx, { tenantId: tenant.id, actor: "system/outbox", now }, "spins", spinId, (cur) =>
        cur.credited_at ? null : { credited_at: now },
      ),
    );
  }
}
