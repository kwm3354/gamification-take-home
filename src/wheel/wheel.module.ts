import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { COIN_LEDGER, type CoinLedger } from "../domain/coin-ledger.ts";
import { OUTBOX, type Outbox } from "../outbox/outbox.ts";
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
      inject: [DB, CLOCK, COIN_LEDGER, OUTBOX],
      useFactory: (db: Db, clock: Clock, coins: CoinLedger, outbox: Outbox) =>
        new SpinService(db, clock, coins, outbox),
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
      await this.spins.creditSpin(job.refId);
      return "done";
    });
  }
}
