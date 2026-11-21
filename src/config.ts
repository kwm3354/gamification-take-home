import { Global, Module } from "@nestjs/common";

export interface Config {
  databaseUrl: string;
  /** TigerBeetle address, `host:port`. The host may be a name; it is resolved at start. */
  tbAddress: string;
  port: number;
  /** Time limit for one ledger call, in ms. */
  ledgerTimeoutMs: number;
  /** Time limit for one call to a casino platform, in ms. */
  platformTimeoutMs: number;
  /** When true a timer runs due outbox jobs every 500 ms. Tests turn it off and run jobs by hand. */
  outboxTimer: boolean;
  /**
   * When true a request runs its own outbox job right after its transaction commits, so the caller
   * sees the result at once. Tests turn it off to stand for "the process died right after the commit".
   */
  inlineJobs: boolean;
  /** When true the two demo tenants are created at start. */
  seedDemo: boolean;
  /** Base address of the fake casino; the demo tenants' platform_url. */
  fakeCasinoUrl: string;
  /** The fake casino's address as the browser sees it. The web app links to it and calls it. */
  publicFakeCasinoUrl: string;
}

/** Injection token for the config. Tests replace it with `overrideProvider(CONFIG)`. */
export const CONFIG = Symbol("CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    databaseUrl: need("DATABASE_URL"),
    tbAddress: need("TB_ADDRESS"),
    port: Number(env.PORT ?? 3000),
    ledgerTimeoutMs: Number(env.LEDGER_TIMEOUT_MS ?? 2000),
    platformTimeoutMs: Number(env.PLATFORM_TIMEOUT_MS ?? 2000),
    outboxTimer: env.OUTBOX_TIMER !== "off",
    inlineJobs: env.INLINE_JOBS !== "off",
    seedDemo: env.SEED_DEMO === "1",
    fakeCasinoUrl: env.FAKE_CASINO_URL ?? "http://fake-casino:4000",
    publicFakeCasinoUrl: env.PUBLIC_FAKE_CASINO_URL ?? "http://localhost:30081",
  };
}

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
