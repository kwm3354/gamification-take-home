import { createHash } from "node:crypto";
import {
  type Account,
  AccountFlags,
  type Client,
  CreateAccountStatus,
  CreateTransferStatus,
  type Transfer,
  TransferFlags,
  amount_max,
} from "tigerbeetle-node";
import { type CoinLedger, LedgerUnavailable } from "../domain/coin-ledger.ts";
import type { Log } from "../logging/log.ts";
import { setSpanAttribute, span } from "../tracing/tracing.ts";

/** A capture came after a release, or a release after a capture. The two must never both happen. */
export class LedgerConflict extends Error {}

const CODE_PLAYER = 1;
const CODE_ISSUER = 10;
const CODE_TRANSFER = 1;
const U128_MAX = (1n << 128n) - 1n;

/** First 16 bytes of SHA-256 of the text, as an unsigned 128-bit number. */
export function ledgerId(text: string): bigint {
  const value = BigInt(`0x${createHash("sha256").update(text).digest().subarray(0, 16).toString("hex")}`);
  if (value === 0n || value === U128_MAX) throw new Error(`id of "${text}" is not usable`); // odds of 2^-127
  return value;
}

const issuerId = (ledgerNo: number) => ledgerId(`acct:${ledgerNo}:issuer`);
const playerAccountId = (ledgerNo: number, playerId: string) =>
  ledgerId(`acct:${ledgerNo}:player:${playerId}`);

function positive(coins: bigint): void {
  if (coins <= 0n) throw new Error(`amount must be above zero, got ${coins}`);
}

function account(id: bigint, ledger: number, code: number, flags: number): Account {
  return {
    id,
    debits_pending: 0n,
    debits_posted: 0n,
    credits_pending: 0n,
    credits_posted: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    reserved: 0,
    ledger,
    code,
    flags,
    timestamp: 0n,
  };
}

function transfer(fields: Partial<Transfer> & Pick<Transfer, "id" | "ledger" | "flags">): Transfer {
  return {
    debit_account_id: 0n,
    credit_account_id: 0n,
    amount: 0n,
    pending_id: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    timeout: 0,
    code: 0,
    timestamp: 0n,
    ...fields,
  };
}

const name = (status: number): string => CreateTransferStatus[status] ?? `status ${status}`;

export class TigerBeetleCoinLedger implements CoinLedger {
  constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
    private readonly log?: Log,
  ) {}

  /**
   * Races a client call against the time limit. The client call itself is not cancelled and may
   * still finish after we gave up. That is safe: every transfer id is derived from the spin or
   * redemption id, so the caller's retry repeats the same transfer and the ledger answers "exists".
   */
  private limited<T>(op: string, work: () => Promise<T>): Promise<T> {
    return span(`ledger ${op}`, {}, () => this.race(op, work));
  }

  private async race<T>(op: string, work: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.log?.event("warn", "ledger.unavailable", { op });
        reject(new LedgerUnavailable(`ledger did not answer in ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    const running = work();
    running.catch(() => {}); // if the time limit wins, a late failure must not become an unhandled rejection
    try {
      return await Promise.race([running, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureAccounts(accounts: Account[]): Promise<void> {
    const results = await this.client.createAccounts(accounts);
    results.forEach((r, i) => {
      if (r.status !== CreateAccountStatus.created && r.status !== CreateAccountStatus.exists) {
        throw new Error(
          `creating account ${accounts[i]?.id} failed: ${CreateAccountStatus[r.status] ?? r.status}`,
        );
      }
    });
  }

  private async one(t: Transfer): Promise<CreateTransferStatus> {
    const [result] = await this.client.createTransfers([t]);
    if (!result) throw new Error("ledger returned no result for a transfer");
    return result.status;
  }

  /** No balance flag: the issuer creates coins, so its debits exceed its credits by design. */
  private issuerAccount(ledgerNo: number): Account {
    return account(issuerId(ledgerNo), ledgerNo, CODE_ISSUER, AccountFlags.none);
  }

  private playerAccount(ledgerNo: number, playerId: string): Account {
    return account(
      playerAccountId(ledgerNo, playerId),
      ledgerNo,
      CODE_PLAYER,
      AccountFlags.debits_must_not_exceed_credits,
    );
  }

  async creditPrize(input: {
    ledgerNo: number;
    playerId: string;
    spinId: string;
    coins: bigint;
  }): Promise<void> {
    positive(input.coins);
    return this.limited("creditPrize", async () => {
      await this.ensureAccounts([
        this.issuerAccount(input.ledgerNo),
        this.playerAccount(input.ledgerNo, input.playerId),
      ]);
      const status = await this.one(
        transfer({
          id: ledgerId(`xfer:prize:${input.spinId}`),
          debit_account_id: issuerId(input.ledgerNo),
          credit_account_id: playerAccountId(input.ledgerNo, input.playerId),
          amount: input.coins,
          ledger: input.ledgerNo,
          code: CODE_TRANSFER,
          flags: TransferFlags.none,
        }),
      );
      if (status !== CreateTransferStatus.created && status !== CreateTransferStatus.exists) {
        throw new Error(`prize transfer failed: ${name(status)}`);
      }
    });
  }

  async reserve(input: {
    ledgerNo: number;
    playerId: string;
    redemptionId: string;
    coins: bigint;
  }): Promise<"reserved" | "insufficient"> {
    positive(input.coins);
    return this.limited("reserve", async () => {
      await this.ensureAccounts([
        this.playerAccount(input.ledgerNo, input.playerId),
        this.issuerAccount(input.ledgerNo),
      ]);
      const status = await this.one(
        transfer({
          id: ledgerId(`xfer:reserve:${input.redemptionId}`),
          debit_account_id: playerAccountId(input.ledgerNo, input.playerId),
          credit_account_id: issuerId(input.ledgerNo),
          amount: input.coins,
          ledger: input.ledgerNo,
          code: CODE_TRANSFER,
          flags: TransferFlags.pending,
        }),
      );
      if (status === CreateTransferStatus.created || status === CreateTransferStatus.exists) {
        setSpanAttribute("ledger.result", "reserved");
        return "reserved";
      }
      if (
        status === CreateTransferStatus.exceeds_credits ||
        status === CreateTransferStatus.id_already_failed
      ) {
        setSpanAttribute("ledger.result", "insufficient");
        return "insufficient";
      }
      throw new Error(`reserve transfer failed: ${name(status)}`);
    });
  }

  capture(input: { ledgerNo: number; redemptionId: string }): Promise<void> {
    return this.limited("capture", async () => {
      const status = await this.one(
        transfer({
          id: ledgerId(`xfer:capture:${input.redemptionId}`),
          pending_id: ledgerId(`xfer:reserve:${input.redemptionId}`),
          amount: amount_max, // the whole pending amount
          flags: TransferFlags.post_pending_transfer,
          ledger: 0,
        }),
      );
      if (status === CreateTransferStatus.created || status === CreateTransferStatus.exists) return;
      if (status === CreateTransferStatus.pending_transfer_already_posted) return;
      if (status === CreateTransferStatus.pending_transfer_already_voided) {
        throw new LedgerConflict(`redemption ${input.redemptionId} was released, it cannot be captured`);
      }
      throw new Error(`capture failed: ${name(status)}`);
    });
  }

  release(input: { ledgerNo: number; redemptionId: string }): Promise<void> {
    return this.limited("release", async () => {
      const status = await this.one(
        transfer({
          id: ledgerId(`xfer:release:${input.redemptionId}`),
          pending_id: ledgerId(`xfer:reserve:${input.redemptionId}`),
          flags: TransferFlags.void_pending_transfer,
          ledger: 0,
        }),
      );
      if (status === CreateTransferStatus.created || status === CreateTransferStatus.exists) return;
      if (status === CreateTransferStatus.pending_transfer_already_voided) return;
      if (status === CreateTransferStatus.pending_transfer_already_posted) {
        throw new LedgerConflict(`redemption ${input.redemptionId} was captured, it cannot be released`);
      }
      throw new Error(`release failed: ${name(status)}`);
    });
  }

  balance(input: { ledgerNo: number; playerId: string }): Promise<{ available: bigint; reserved: bigint }> {
    return this.limited("balance", async () => {
      const [found] = await this.client.lookupAccounts([playerAccountId(input.ledgerNo, input.playerId)]);
      if (!found) return { available: 0n, reserved: 0n };
      return {
        available: found.credits_posted - found.debits_posted - found.debits_pending,
        reserved: found.debits_pending,
      };
    });
  }

  outstanding(input: { ledgerNo: number }): Promise<bigint> {
    return this.limited("outstanding", async () => {
      // One account: what left the issuer minus what came back. Pending reserves do not count yet.
      const [issuer] = await this.client.lookupAccounts([issuerId(input.ledgerNo)]);
      return (issuer?.debits_posted ?? 0n) - (issuer?.credits_posted ?? 0n);
    });
  }
}
