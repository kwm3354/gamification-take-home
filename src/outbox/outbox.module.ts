import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { OUTBOX, Outbox } from "./outbox.ts";

/** The queue of outgoing calls. A timer runs due jobs (not in role `api`); tests turn it off and call `runDue` by hand. */
@Global()
@Module({
  providers: [
    {
      provide: OUTBOX,
      inject: [DB, CLOCK, LOG, CONFIG],
      useFactory: (db: Db, clock: Clock, log: Log, config: Config) =>
        new Outbox(db, clock, log, { batch: config.outboxBatch }),
    },
  ],
  exports: [OUTBOX],
})
export class OutboxModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOG) private readonly log: Log,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outboxTimer) return;
    this.timer = setInterval(() => void this.tick(), this.config.outboxPollMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a run must not overlap the previous one
    this.running = true;
    try {
      await this.outbox.runDue();
    } catch (e) {
      this.log.event("error", "unhandled", {
        where: "outbox_tick",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }
}
