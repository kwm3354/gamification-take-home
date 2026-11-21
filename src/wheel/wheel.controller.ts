import { randomUUID } from "node:crypto";
import { Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { LedgerUnavailable } from "../domain/coin-ledger.ts";
import { LOG } from "../logging/log.module.ts";
import { type Log, currentRequestId } from "../logging/log.ts";
import { CurrentPlayer, type PlayerAuth, PlayerAuthGuard } from "../tenants/player-auth.guard.ts";
import type { Segment } from "./pick-segment.ts";
import { SpinService } from "./spin.ts";

@Controller("wheel")
@UseGuards(PlayerAuthGuard)
export class WheelController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(SpinService) private readonly spins: SpinService,
    @Inject(LOG) private readonly log: Log,
  ) {}

  @Get()
  async wheel(@CurrentPlayer() auth: PlayerAuth) {
    const r = await this.db.query(
      "SELECT version, segments FROM wheel_configs WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
      [auth.tenant.id],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundException();
    return {
      version: row.version as number,
      segments: (row.segments as Segment[]).map((s) => ({ label: s.label, coins: s.coins })),
    };
  }

  @Post("spins/:spinId/spin")
  @HttpCode(200)
  async spin(@CurrentPlayer() auth: PlayerAuth, @Param("spinId") spinId: string) {
    const done = await this.spins.spin(
      auth.tenant,
      auth.player.id,
      spinId,
      currentRequestId() ?? randomUUID(),
    );
    if (!done) throw new NotFoundException();
    if (done.fresh && this.config.inlineJobs) {
      try {
        await this.spins.creditSpin(spinId);
      } catch (e) {
        // The job is queued and will retry. The answer does not wait for a healthy ledger.
        if (!(e instanceof LedgerUnavailable)) throw e;
        this.log.event("warn", "spin.credit_deferred", {
          tenantId: auth.tenant.id,
          spinId,
          error: e.message,
        });
      }
    }
    return done.result;
  }
}
