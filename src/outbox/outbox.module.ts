import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { OUTBOX, Outbox } from "./outbox.ts";

const TICK_MS = 500;

/** The queue of outgoing calls. A timer runs due jobs; tests turn it off and call `runDue` by hand. */
@Global()
@Module({
  providers: [
    { provide: OUTBOX, inject: [DB, CLOCK], useFactory: (db: Db, clock: Clock) => new Outbox(db, clock) },
  ],
  exports: [OUTBOX],
})
export class OutboxModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("Outbox");
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outboxTimer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
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
      this.log.error(`outbox run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
