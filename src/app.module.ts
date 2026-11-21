import { Module } from "@nestjs/common";
import { ConfigModule } from "./config.ts";
import { DbModule } from "./db.module.ts";
import { EventsModule } from "./events/events.module.ts";
import { HealthModule } from "./health/health.module.ts";
import { IntegrationsModule } from "./integrations/integrations.module.ts";
import { LedgerModule } from "./ledger/ledger.module.ts";
import { OutboxModule } from "./outbox/outbox.module.ts";
import { StoreModule } from "./store/store.module.ts";
import { TenantsModule } from "./tenants/tenants.module.ts";
import { WheelModule } from "./wheel/wheel.module.ts";

// ConfigModule, DbModule and LedgerModule are global: any module can inject CONFIG, DB and LEDGER.
@Module({
  imports: [
    ConfigModule,
    DbModule,
    LedgerModule,
    HealthModule,
    TenantsModule,
    IntegrationsModule,
    EventsModule,
    WheelModule,
    StoreModule,
    OutboxModule,
  ],
})
export class AppModule {}
