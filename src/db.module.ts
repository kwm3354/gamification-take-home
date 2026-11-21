import { Global, Inject, Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type Config } from "./config.ts";
import { type Db, connect, migrate } from "./db.ts";

/** Injection token for the PostgreSQL pool: `@Inject(DB) private readonly db: Db`. */
export const DB = Symbol("DB");

@Global()
@Module({
  providers: [{ provide: DB, inject: [CONFIG], useFactory: (config: Config) => connect(config.databaseUrl) }],
  exports: [DB],
})
export class DbModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The schema is applied at every start. `schema.sql` must stay safe to run twice. */
  async onModuleInit(): Promise<void> {
    await migrate(this.db);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.end();
  }
}
