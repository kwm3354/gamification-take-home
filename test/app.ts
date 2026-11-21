import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.ts";
import { CLOCK } from "../src/clock.module.ts";
import { FakeClock } from "../src/clock.ts";
import { CONFIG, type Config } from "../src/config.ts";
import { DB } from "../src/db.module.ts";
import type { Db } from "../src/db.ts";
import { LEDGER, type Ledger } from "../src/ledger/ledger.module.ts";
import { LOG_LEVELS, LOG_SINK, type TenantLevels } from "../src/logging/log.module.ts";
import { mountWeb } from "../src/web.ts";
import { freshDb } from "./harness.ts";
import { startTigerBeetle } from "./tigerbeetle.ts";

export const TEST_ADMIN_TOKEN_SECRET = "test-admin-token-secret-0123456789abcdef";

export interface TestApp {
  /** Base address of the running app, for example `http://127.0.0.1:41234`. */
  url: string;
  app: INestApplication;
  db: Db;
  ledger: Ledger;
  /** The app's clock. It only moves when the test moves it. */
  clock: FakeClock;
  /** The config the app runs with. */
  config: Config;
  /** Every log line the app wrote, parsed. `logs.length = 0` clears it (clear `rawLogs` too). */
  logs: Record<string, unknown>[];
  /** The same lines as the sink got them, before parsing. */
  rawLogs: string[];
  /** The per-tenant log level cache; `await levels.settled()` after moving the clock past 30 s. */
  levels: TenantLevels;
  close: () => Promise<void>;
}

/**
 * Boots the whole Nest app in this process on a random port, with a fresh database and a
 * TigerBeetle from test/tigerbeetle.ts. Returns undefined when no TigerBeetle is available
 * (neither TB_ADDRESS nor TB_BIN is set), so the test file can skip.
 * `tbAddress` replaces the ledger address, to test what happens when the ledger is away.
 * `config` overrides single settings. `webDir` is the folder served at `/app/` (none by default). The clock starts at the real time and then stands still.
 */
export async function startApp(
  options: { tbAddress?: string; config?: Partial<Config>; webDir?: string | null } = {},
): Promise<TestApp | undefined> {
  const tb = options.tbAddress ? { address: options.tbAddress, stop: () => {} } : await startTigerBeetle();
  if (!tb) return undefined;
  const { db } = await freshDb();
  const clock = new FakeClock(new Date().toISOString());
  const config: Config = {
    databaseUrl: "replaced by the DB override",
    role: "all",
    outboxBatch: 16,
    outboxPollMs: 500,
    dbPoolMax: 5,
    tbAddress: tb.address,
    port: 0,
    ledgerTimeoutMs: 2000,
    platformTimeoutMs: 300,
    outboxTimer: false,
    inlineJobs: true,
    inlineMax: 64,
    adminTokenSecret: TEST_ADMIN_TOKEN_SECRET,
    seedDemo: false,
    fakeCasinoUrl: "http://127.0.0.1:1",
    publicFakeCasinoUrl: "http://localhost:30081",
    ...options.config,
  };
  const logs: Record<string, unknown>[] = [];
  const rawLogs: string[] = [];
  const sink = {
    write: (line: string) => {
      rawLogs.push(line);
      logs.push(JSON.parse(line));
    },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(LOG_SINK)
    .useValue(sink)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  mountWeb(app, {
    dir: options.webDir ?? null,
    fakeCasinoUrl: config.publicFakeCasinoUrl,
    demoAdmins: config.seedDemo,
  });
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    db,
    ledger: app.get<Ledger>(LEDGER),
    clock,
    config,
    logs,
    rawLogs,
    levels: app.get<TenantLevels>(LOG_LEVELS),
    close: async () => {
      await app.close(); // closes the database pool and the ledger client
      tb.stop();
    },
  };
}
