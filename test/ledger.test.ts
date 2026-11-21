import { randomInt, randomUUID } from "node:crypto";
import { type Client, createClient } from "tigerbeetle-node";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LedgerUnavailable } from "../src/domain/coin-ledger.ts";
import { LedgerConflict, TigerBeetleCoinLedger, ledgerId } from "../src/ledger/coin-ledger.tigerbeetle.ts";
import { startTigerBeetle } from "./tigerbeetle.ts";

// Real TigerBeetle, no mocks. All test files may share one server, so every test uses its own
// random ledger number and random ids.
const tb = await startTigerBeetle();
let client: Client;
let ledger: TigerBeetleCoinLedger;

beforeAll(() => {
  if (!tb) return;
  client = createClient({ cluster_id: 0n, replica_addresses: [tb.address] });
  ledger = new TigerBeetleCoinLedger(client, 5000);
});
afterAll(() => {
  client?.destroy();
  tb?.stop();
});

const newLedgerNo = () => randomInt(1000, 2 ** 31 - 1);

/** A tenant with one player who has been credited `coins` by a prize. */
async function funded(coins: bigint) {
  const ledgerNo = newLedgerNo();
  const playerId = randomUUID();
  if (coins > 0n) await ledger.creditPrize({ ledgerNo, playerId, spinId: randomUUID(), coins });
  return { ledgerNo, playerId };
}

describe.skipIf(!tb)("coin ledger on TigerBeetle", () => {
  test("a prize with the same spin id is credited once", async () => {
    const { ledgerNo, playerId } = await funded(0n);
    const spinId = randomUUID();
    await ledger.creditPrize({ ledgerNo, playerId, spinId, coins: 50n });
    await ledger.creditPrize({ ledgerNo, playerId, spinId, coins: 50n });
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 50n, reserved: 0n });
  });

  test("an account that does not exist has balance 0", async () => {
    expect(await ledger.balance({ ledgerNo: newLedgerNo(), playerId: "nobody" })).toEqual({
      available: 0n,
      reserved: 0n,
    });
  });

  test("amounts of zero or less are refused", async () => {
    const { ledgerNo, playerId } = await funded(10n);
    await expect(
      ledger.creditPrize({ ledgerNo, playerId, spinId: randomUUID(), coins: 0n }),
    ).rejects.toThrow();
    await expect(
      ledger.reserve({ ledgerNo, playerId, redemptionId: randomUUID(), coins: -1n }),
    ).rejects.toThrow();
  });

  test("reserving more than the balance is insufficient, and stays so for that redemption id", async () => {
    const { ledgerNo, playerId } = await funded(100n);
    const redemptionId = randomUUID();
    expect(await ledger.reserve({ ledgerNo, playerId, redemptionId, coins: 101n })).toBe("insufficient");
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 100n, reserved: 0n });

    await ledger.creditPrize({ ledgerNo, playerId, spinId: randomUUID(), coins: 500n });
    expect(await ledger.reserve({ ledgerNo, playerId, redemptionId, coins: 101n })).toBe("insufficient");
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 600n, reserved: 0n });
  });

  test("20 concurrent reserves of 100 coins against 500: exactly 5 succeed", async () => {
    const { ledgerNo, playerId } = await funded(500n);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ledger.reserve({ ledgerNo, playerId, redemptionId: randomUUID(), coins: 100n }),
      ),
    );
    expect(results.filter((r) => r === "reserved")).toHaveLength(5);
    expect(results.filter((r) => r === "insufficient")).toHaveLength(15);
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 0n, reserved: 500n });
  });

  test("the same reserve called 5 times at once reserves once", async () => {
    const { ledgerNo, playerId } = await funded(500n);
    const redemptionId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ledger.reserve({ ledgerNo, playerId, redemptionId, coins: 100n })),
    );
    expect(results).toEqual(Array(5).fill("reserved"));
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 400n, reserved: 100n });
  });

  test("capture turns the reserve into a debit, and twice is fine", async () => {
    const { ledgerNo, playerId } = await funded(500n);
    const redemptionId = randomUUID();
    await ledger.reserve({ ledgerNo, playerId, redemptionId, coins: 300n });
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 200n, reserved: 300n });
    expect(await ledger.outstanding({ ledgerNo })).toBe(500n);

    await ledger.capture({ ledgerNo, redemptionId });
    await ledger.capture({ ledgerNo, redemptionId });
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 200n, reserved: 0n });
    // the whole amount was posted: the coins left the players' hands
    expect(await ledger.outstanding({ ledgerNo })).toBe(200n);
  });

  test("release gives the coins back, twice is fine, and capture after release is a conflict", async () => {
    const { ledgerNo, playerId } = await funded(500n);
    const redemptionId = randomUUID();
    await ledger.reserve({ ledgerNo, playerId, redemptionId, coins: 300n });
    await ledger.release({ ledgerNo, redemptionId });
    await ledger.release({ ledgerNo, redemptionId });
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 500n, reserved: 0n });
    await expect(ledger.capture({ ledgerNo, redemptionId })).rejects.toBeInstanceOf(LedgerConflict);
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 500n, reserved: 0n });
  });

  test("release after capture is a conflict and changes nothing", async () => {
    const { ledgerNo, playerId } = await funded(500n);
    const redemptionId = randomUUID();
    await ledger.reserve({ ledgerNo, playerId, redemptionId, coins: 300n });
    await ledger.capture({ ledgerNo, redemptionId });
    await expect(ledger.release({ ledgerNo, redemptionId })).rejects.toBeInstanceOf(LedgerConflict);
    expect(await ledger.balance({ ledgerNo, playerId })).toEqual({ available: 200n, reserved: 0n });
  });

  test("outstanding is issued minus captured, for a tenant with two players", async () => {
    const ledgerNo = newLedgerNo();
    const [a, b] = [randomUUID(), randomUUID()];
    await ledger.creditPrize({ ledgerNo, playerId: a, spinId: randomUUID(), coins: 100n });
    await ledger.creditPrize({ ledgerNo, playerId: b, spinId: randomUUID(), coins: 50n });
    expect(await ledger.outstanding({ ledgerNo })).toBe(150n);

    const captured = randomUUID();
    await ledger.reserve({ ledgerNo, playerId: a, redemptionId: captured, coins: 40n });
    await ledger.capture({ ledgerNo, redemptionId: captured });
    const released = randomUUID();
    await ledger.reserve({ ledgerNo, playerId: b, redemptionId: released, coins: 30n });
    await ledger.release({ ledgerNo, redemptionId: released });
    expect(await ledger.outstanding({ ledgerNo })).toBe(110n);
  });

  test("outstanding is the net balance of the ONE issuer account; a pending reserve is not yet 'come back'", async () => {
    const ledgerNo = newLedgerNo();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await ledger.creditPrize({ ledgerNo, playerId: a, spinId: randomUUID(), coins: 100n });
    await ledger.creditPrize({ ledgerNo, playerId: b, spinId: randomUUID(), coins: 50n });
    await ledger.creditPrize({ ledgerNo, playerId: c, spinId: randomUUID(), coins: 20n });
    const captured = randomUUID();
    await ledger.reserve({ ledgerNo, playerId: a, redemptionId: captured, coins: 40n });
    await ledger.capture({ ledgerNo, redemptionId: captured });
    const released = randomUUID();
    await ledger.reserve({ ledgerNo, playerId: b, redemptionId: released, coins: 30n });
    await ledger.release({ ledgerNo, redemptionId: released });
    // A pending reserve is a promise, not a return: the coins have not come back to the issuer yet.
    await ledger.reserve({ ledgerNo, playerId: c, redemptionId: randomUUID(), coins: 15n });

    const [issuer] = await client.lookupAccounts([ledgerId(`acct:${ledgerNo}:issuer`)]);
    expect(issuer?.debits_posted).toBe(170n); // all prizes
    expect(issuer?.credits_posted).toBe(40n); // only the captured redemption
    expect(issuer?.credits_pending).toBe(15n); // the open reserve
    expect(await ledger.outstanding({ ledgerNo })).toBe(130n);
    expect(await ledger.outstanding({ ledgerNo })).toBe(issuer!.debits_posted - issuer!.credits_posted);
    // There is no second tenant account any more.
    expect(await client.lookupAccounts([ledgerId(`acct:${ledgerNo}:redeemed`)])).toHaveLength(0);
  });

  test("outstanding of a tenant that never issued anything is 0", async () => {
    expect(await ledger.outstanding({ ledgerNo: newLedgerNo() })).toBe(0n);
  });

  test("two tenants with the same player id have separate balances", async () => {
    const playerId = randomUUID();
    const [one, two] = [newLedgerNo(), newLedgerNo()];
    await ledger.creditPrize({ ledgerNo: one, playerId, spinId: randomUUID(), coins: 100n });
    await ledger.creditPrize({ ledgerNo: two, playerId, spinId: randomUUID(), coins: 7n });
    expect(await ledger.balance({ ledgerNo: one, playerId })).toEqual({ available: 100n, reserved: 0n });
    expect(await ledger.balance({ ledgerNo: two, playerId })).toEqual({ available: 7n, reserved: 0n });
    // coins of tenant one cannot pay in tenant two
    expect(await ledger.reserve({ ledgerNo: two, playerId, redemptionId: randomUUID(), coins: 50n })).toBe(
      "insufficient",
    );
  });

  test("a ledger that does not answer throws LedgerUnavailable within about a second", async () => {
    const dead = createClient({ cluster_id: 0n, replica_addresses: ["127.0.0.1:1"] });
    try {
      const slow = new TigerBeetleCoinLedger(dead, 300);
      const started = performance.now();
      await expect(slow.balance({ ledgerNo: newLedgerNo(), playerId: "p" })).rejects.toBeInstanceOf(
        LedgerUnavailable,
      );
      await expect(
        slow.creditPrize({ ledgerNo: 5, playerId: "p", spinId: randomUUID(), coins: 1n }),
      ).rejects.toBeInstanceOf(LedgerUnavailable);
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      dead.destroy();
    }
  });
});
