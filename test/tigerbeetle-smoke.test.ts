import { AccountFlags, type Client, TransferFlags, createClient, id } from "tigerbeetle-node";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startTigerBeetle } from "./tigerbeetle.ts";

// Proves the ledger toolchain works here: a server starts, the client connects, a transfer moves
// value, a repeated transfer id does not move it twice, and a pending transfer can be voided.
// Skipped when TB_BIN is not set. Replace with real ledger tests once the design exists.
const tb = await startTigerBeetle();
let client: Client;

beforeAll(() => {
  if (tb) client = createClient({ cluster_id: 0n, replica_addresses: [tb.address] });
});
afterAll(() => {
  client?.destroy();
  tb?.stop();
});

const account = (accountId: bigint, flags: number) => ({
  id: accountId,
  debits_pending: 0n,
  debits_posted: 0n,
  credits_pending: 0n,
  credits_posted: 0n,
  user_data_128: 0n,
  user_data_64: 0n,
  user_data_32: 0,
  reserved: 0,
  ledger: 1,
  code: 1,
  flags,
  timestamp: 0n,
});

test.skipIf(!tb)("a transfer moves value once, and a pending one can be voided", async () => {
  const from = id();
  const to = id();
  await client.createAccounts([account(from, 0), account(to, AccountFlags.debits_must_not_exceed_credits)]);

  const transfer = (transferId: bigint, amount: bigint, flags = 0, pendingId = 0n) => ({
    id: transferId,
    debit_account_id: from,
    credit_account_id: to,
    amount,
    pending_id: pendingId,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    timeout: 0,
    ledger: 1,
    code: 1,
    flags,
    timestamp: 0n,
  });

  const once = id();
  await client.createTransfers([transfer(once, 100n)]);
  await client.createTransfers([transfer(once, 100n)]); // same id again: must not move value twice

  const pending = id();
  await client.createTransfers([transfer(pending, 30n, TransferFlags.pending)]);
  await client.createTransfers([transfer(id(), 0n, TransferFlags.void_pending_transfer, pending)]);

  const [, receiver] = await client.lookupAccounts([from, to]);
  expect(receiver?.credits_posted).toBe(100n);
  expect(receiver?.credits_pending).toBe(0n);
});
