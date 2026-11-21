import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Global,
  HttpException,
  Inject,
  Module,
} from "@nestjs/common";
import { APP_FILTER, HttpAdapterHost } from "@nestjs/core";
import { loadOpsPolicy } from "../alerts/ops-policy.ts";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { type Level, Log, type LogSink, stdoutSink } from "./log.ts";

export const LOG = Symbol("LOG");
export const LOG_SINK = Symbol("LOG_SINK");
export const LOG_LEVELS = Symbol("LOG_LEVELS");

const CACHE_MS = 30_000;

/**
 * The log level of each tenant, from its newest ops policy, cached for 30 seconds by the injected
 * clock. `levelFor` never waits: a missing or stale entry starts a refresh in the background and
 * the old value (or "info") is used meanwhile. A failed refresh keeps the old value.
 */
export class TenantLevels {
  private readonly cache = new Map<string, { level: Level; at: number }>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Pick<Db, "query">,
    private readonly clock: Clock,
  ) {}

  levelFor(tenantId: string | null): Level {
    if (tenantId === null) return "info";
    const entry = this.cache.get(tenantId);
    if (!entry || this.clock.now().getTime() - entry.at >= CACHE_MS) this.refresh(tenantId);
    return entry?.level ?? "info";
  }

  private refresh(tenantId: string): void {
    if (this.loading.has(tenantId)) return;
    const at = this.clock.now().getTime();
    const work = loadOpsPolicy(this.db, tenantId)
      .then((policy) => {
        this.cache.set(tenantId, { level: policy?.params.logLevel ?? "info", at });
      })
      .catch(() => {}) // keep the old value; the next stale read tries again
      .finally(() => this.loading.delete(tenantId));
    this.loading.set(tenantId, work);
  }

  /** Resolves when the running refreshes are done. For tests. */
  async settled(): Promise<void> {
    await Promise.all([...this.loading.values()]);
  }
}

/** An exception that is not an HTTP error becomes one `unhandled` line and a plain 500. HTTP errors answer as Nest does. */
@Catch()
export class UnhandledFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(LOG) private readonly log: Log,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const adapter = this.host.httpAdapter;
    const res = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();
      adapter.reply(res, typeof body === "string" ? { statusCode: status, message: body } : body, status);
      return;
    }
    this.log.event("error", "unhandled", {
      error: exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    });
    adapter.reply(res, { statusCode: 500, message: "Internal server error" }, 500);
  }
}

@Global()
@Module({
  providers: [
    { provide: LOG_SINK, useValue: stdoutSink },
    {
      provide: LOG_LEVELS,
      inject: [DB, CLOCK],
      useFactory: (db: Db, clock: Clock) => new TenantLevels(db, clock),
    },
    {
      provide: LOG,
      inject: [LOG_SINK, CLOCK, LOG_LEVELS],
      useFactory: (sink: LogSink, clock: Clock, levels: TenantLevels) =>
        new Log(sink, clock, (tenantId) => levels.levelFor(tenantId)),
    },
    { provide: APP_FILTER, useClass: UnhandledFilter },
  ],
  exports: [LOG, LOG_SINK, LOG_LEVELS],
})
export class LogModule {}
