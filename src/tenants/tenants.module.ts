import { Inject, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { MeController } from "./me.controller.ts";
import { PlayerAuthGuard } from "./player-auth.guard.ts";
import { seedDemo } from "./seed.ts";

/** Tenants and player identity. Export the guard to put an endpoint behind a player token. */
@Module({
  controllers: [MeController],
  providers: [PlayerAuthGuard],
  exports: [PlayerAuthGuard],
})
export class TenantsModule implements OnApplicationBootstrap {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.seedDemo) await seedDemo(this.db, this.clock, this.config.fakeCasinoUrl);
  }
}
