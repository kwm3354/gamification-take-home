import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { AdminModule } from "./admin/admin.module.ts";
import { ClockModule } from "./clock.module.ts";
import { ConfigModule } from "./config.ts";
import { DbModule } from "./db.module.ts";
import { EventsModule } from "./events/events.module.ts";
import { HealthModule } from "./health/health.module.ts";
import { IntegrationsModule } from "./integrations/integrations.module.ts";
import { LedgerModule } from "./ledger/ledger.module.ts";
import { LogModule } from "./logging/log.module.ts";
import { RequestIdMiddleware } from "./logging/request-id.ts";
import { OutboxModule } from "./outbox/outbox.module.ts";
import { StoreModule } from "./store/store.module.ts";
import { TenantsModule } from "./tenants/tenants.module.ts";
import { WheelModule } from "./wheel/wheel.module.ts";

// ConfigModule, ClockModule, DbModule, LogModule and LedgerModule are global: any module can inject CONFIG, CLOCK, DB, LOG and LEDGER.
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    DbModule,
    LogModule,
    LedgerModule,
    HealthModule,
    TenantsModule,
    IntegrationsModule,
    EventsModule,
    WheelModule,
    StoreModule,
    AdminModule,
    OutboxModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
