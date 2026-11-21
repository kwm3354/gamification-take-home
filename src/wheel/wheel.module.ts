import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { COIN_LEDGER, type CoinLedger, LedgerUnavailable } from "../domain/coin-ledger.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { OUTBOX, type Outbox } from "../outbox/outbox.ts";
import { backoffMs } from "../store/redemption.ts";
import { TenantsModule } from "../tenants/tenants.module.ts";
import { SpinService } from "./spin.ts";
import { WheelController } from "./wheel.controller.ts";

/** The wheel: using a spin and crediting the prize. */
@Module({
  imports: [TenantsModule],
  controllers: [WheelController],
  providers: [
    {
      provide: SpinService,
      inject: [DB, CLOCK, COIN_LEDGER, OUTBOX, LOG],
      useFactory: (db: Db, clock: Clock, coins: CoinLedger, outbox: Outbox, log: Log) =>
        new SpinService(db, clock, coins, outbox, log),
    },
  ],
})
export class WheelModule implements OnModuleInit {
  constructor(
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(SpinService) private readonly spins: SpinService,
  ) {}

  onModuleInit(): void {
    this.outbox.handle("spin_credit", async (job) => {
      try {
        await this.spins.creditSpin(job.refId);
      } catch (e) {
        // A ledger outage must not use up the attempts: the prize is already owed to the player.
        if (e instanceof LedgerUnavailable) return { retryInMs: backoffMs(job.attempts) };
        throw e;
      }
      return "done";
    });
  }
}
