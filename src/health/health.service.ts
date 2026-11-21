import { Inject, Injectable } from "@nestjs/common";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { LEDGER, type Ledger } from "../ledger/ledger.module.ts";

export interface Health {
  ok: boolean;
  postgres: string;
  ledger: string;
}

const TIMEOUT_MS = 2000;

/** Gives up waiting after TIMEOUT_MS. It does not cancel the call it waits for. */
async function probe(call: () => Promise<unknown>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      call(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
      }),
    ]);
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LEDGER) private readonly ledger: Ledger,
  ) {}

  async check(): Promise<Health> {
    const [postgres, ledger] = await Promise.all([
      probe(() => this.db.query("SELECT 1")),
      // Looking up an account that does not exist is a full round trip to the ledger.
      probe(() => this.ledger.lookupAccounts([1n])),
    ]);
    return { ok: postgres === "ok" && ledger === "ok", postgres, ledger };
  }
}
