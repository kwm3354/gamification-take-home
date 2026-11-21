import { Global, Module } from "@nestjs/common";

export interface Config {
  databaseUrl: string;
  /** TigerBeetle address, `host:port`. The host may be a name; it is resolved at start. */
  tbAddress: string;
  port: number;
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
  };
}

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
