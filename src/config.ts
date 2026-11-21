import { Global, Module } from "@nestjs/common";

/**
 * What this process does. `all`: HTTP API and the outbox timer. `api`: HTTP API only; a request still
 * runs its own job inline. `worker`: the outbox timer; the HTTP server listens too but a worker is not
 * published: nothing routes traffic to it, and its health check is the only thing that calls it.
 */
export type Role = "all" | "api" | "worker";

export interface Config {
  role: Role;
  /** How many jobs one outbox claim takes. */
  outboxBatch: number;
  /** How often the outbox timer looks for due jobs, in ms. */
  outboxPollMs: number;
  databaseUrl: string;
  /** Largest number of PostgreSQL connections in this process's pool. */
  dbPoolMax: number;
  /** TigerBeetle address, `host:port`. The host may be a name; it is resolved at start. */
  tbAddress: string;
  port: number;
  /** Time limit for one ledger call, in ms. */
  ledgerTimeoutMs: number;
  /** Time limit for one call to a casino platform, in ms. */
  platformTimeoutMs: number;
  /** When true a timer runs due outbox jobs. Off for role `api`. Tests turn it off and run jobs by hand. */
  outboxTimer: boolean;
  /**
   * When true a request runs its own outbox job right after its transaction commits, so the caller
   * sees the result at once. Tests turn it off to stand for "the process died right after the commit".
   */
  inlineJobs: boolean;
  /**
   * How many requests in this process may run their own redemption job at the same time. Over it a
   * request skips the inline run and leaves the job to the outbox. It never queues.
   */
  inlineMax: number;
  /** Secret that signs back office tokens. At least 32 characters. */
  adminTokenSecret: string;
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
  const adminTokenSecret = need("ADMIN_TOKEN_SECRET");
  if (adminTokenSecret.length < 32) throw new Error("ADMIN_TOKEN_SECRET must be at least 32 characters");
  const role = env.ROLE ?? "all";
  if (role !== "all" && role !== "api" && role !== "worker")
    throw new Error("ROLE must be all, api or worker");
  return {
    role,
    outboxBatch: Number(env.OUTBOX_BATCH ?? 16),
    outboxPollMs: Number(env.OUTBOX_POLL_MS ?? 500),
    databaseUrl: need("DATABASE_URL"),
    tbAddress: need("TB_ADDRESS"),
    dbPoolMax: Number(env.DB_POOL_MAX ?? 20),
    port: Number(env.PORT ?? 3000),
    ledgerTimeoutMs: Number(env.LEDGER_TIMEOUT_MS ?? 2000),
    platformTimeoutMs: Number(env.PLATFORM_TIMEOUT_MS ?? 2000),
    outboxTimer: env.OUTBOX_TIMER !== "off" && role !== "api",
    inlineJobs: env.INLINE_JOBS !== "off",
    inlineMax: Number(env.INLINE_MAX ?? 32),
    adminTokenSecret,
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
