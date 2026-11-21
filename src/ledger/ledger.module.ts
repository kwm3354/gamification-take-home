import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { type Client, createClient } from "tigerbeetle-node";
import { CONFIG, type Config } from "../config.ts";
import { COIN_LEDGER } from "../domain/coin-ledger.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { TigerBeetleCoinLedger } from "./coin-ledger.tigerbeetle.ts";

/** Injection token for the TigerBeetle client: `@Inject(LEDGER) private readonly ledger: Ledger`. */
export const LEDGER = Symbol("LEDGER");
export type Ledger = Client;

/** The TigerBeetle client takes IP addresses only, so a host name (as in docker compose) is resolved here. */
async function resolveAddress(address: string): Promise<string> {
  const split = address.lastIndexOf(":");
  if (split < 0) return address;
  const host = address.slice(0, split);
  if (isIP(host)) return address;
  const { address: ip } = await lookup(host, { family: 4 });
  return `${ip}${address.slice(split)}`;
}

@Global()
@Module({
  providers: [
    {
      provide: LEDGER,
      inject: [CONFIG],
      useFactory: async (config: Config): Promise<Ledger> =>
        createClient({ cluster_id: 0n, replica_addresses: [await resolveAddress(config.tbAddress)] }),
    },
    {
      provide: COIN_LEDGER,
      inject: [LEDGER, CONFIG, LOG],
      useFactory: (client: Ledger, config: Config, log: Log) =>
        new TigerBeetleCoinLedger(client, config.ledgerTimeoutMs, log),
    },
  ],
  exports: [LEDGER, COIN_LEDGER],
})
export class LedgerModule implements OnApplicationShutdown {
  constructor(@Inject(LEDGER) private readonly ledger: Ledger) {}

  onApplicationShutdown(): void {
    this.ledger.destroy();
  }
}
