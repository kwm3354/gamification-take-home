import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { PLATFORMS, type Platforms, type RewardNotice } from "../domain/casino-platform.ts";
import { COIN_LEDGER, type CoinLedger } from "../domain/coin-ledger.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { OUTBOX, type Outbox } from "../outbox/outbox.ts";
import {
  InlineGate,
  JOB_KIND,
  type RedemptionView,
  type Step,
  type StoreDeps,
  applyNotice,
  backoffMs,
  createRedemption,
  findRedemption,
  runInline,
  step,
  toView,
} from "./redemption.ts";

/** Thin wiring around src/store/redemption.ts. */
@Injectable()
export class StoreService implements OnModuleInit {
  private readonly deps: StoreDeps;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) clock: Clock,
    @Inject(COIN_LEDGER) coins: CoinLedger,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(PLATFORMS) platforms: Platforms,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOG) private readonly log: Log,
  ) {
    this.deps = {
      db,
      clock,
      coins,
      outbox,
      platforms,
      platformTimeoutMs: config.platformTimeoutMs,
      inline: new InlineGate(config.inlineMax),
      log,
    };
  }

  onModuleInit(): void {
    this.outbox.handle(JOB_KIND, async (job) => {
      const result = await step(this.deps, job.refId, { attempts: job.attempts, actor: "system/outbox" });
      if (result === "done") return "done";
      return result === "again" ? { retryInMs: 0 } : result;
    });
  }

  async items(tenantId: string) {
    const { rows } = await this.db.query(
      `SELECT id, code, name, cost_coins, reward FROM store_items
       WHERE tenant_id = $1 AND active ORDER BY cost_coins, code`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      costCoins: String(r.cost_coins),
      reward: r.reward,
    }));
  }

  /** `unknown_item` is a 404. Otherwise the redemption as it is after the inline run. */
  async redeem(input: {
    tenantId: string;
    playerId: string;
    externalPlayerId: string;
    idempotencyKey: string;
    itemId: string;
    requestId?: string;
  }): Promise<"unknown_item" | { view: RedemptionView; created: boolean }> {
    const actor = `player/${input.playerId}`;
    const made = await createRedemption(this.deps, { ...input, actor });
    if (made === "unknown_item") return made;
    if (made.created && this.config.inlineJobs) await this.inline(made.row.id, actor);
    const row = await findRedemption(this.db, input.tenantId, made.row.id);
    return { view: toView(row ?? made.row), created: made.created };
  }

  async get(tenantId: string, playerId: string, id: string): Promise<RedemptionView | null> {
    const row = await findRedemption(this.db, tenantId, id, playerId);
    return row ? toView(row) : null;
  }

  /** A reward message from the platform. Null when the redemption is not this tenant's. */
  async onRewardNotice(tenantId: string, notice: RewardNotice): Promise<RedemptionView | null> {
    const actor = `platform/${tenantId}`;
    const row = await applyNotice(this.deps, tenantId, notice, actor);
    if (!row) return null;
    if (this.config.inlineJobs) await this.inline(row.id, actor, 1);
    const after = await findRedemption(this.db, tenantId, row.id);
    return toView(after ?? row);
  }

  /** One step of the job, for tests and tools. The caller is the job runner's stand-in. */
  advance(redemptionId: string, attempts = 0, actor = "system/test"): Promise<Step> {
    return step(this.deps, redemptionId, { attempts, actor });
  }

  private async inline(id: string, actor: string, maxSteps?: number): Promise<void> {
    try {
      await runInline(this.deps, id, actor, maxSteps);
    } catch (e) {
      // The job stays in the outbox; the timer will run it again.
      this.log.event("error", "unhandled", {
        where: "inline_run",
        redemptionId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export { backoffMs };
