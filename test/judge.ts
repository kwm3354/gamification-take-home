import type { INestApplication } from "@nestjs/common";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import type { FakeState } from "../src/fake-casino/state.ts";
import type { TestApp } from "./app.ts";

/**
 * The judge for redemptions (docs/contracts.md, "What must never happen", points 3 to 6).
 * It trusts what the fake casino recorded and what the ledger says. Our redemption rows are used
 * only to know what we CLAIM; a claim is checked against the outside world.
 */

export interface JudgedRedemption {
  id: string;
  tenantId: string;
  externalPlayerId: string;
  status: string;
  settled: boolean;
  costCoins: bigint;
}

export interface JudgedBalance {
  tenantId: string;
  externalPlayerId: string;
  /** Coins given to the player in the test setup. */
  creditedCoins: bigint;
  available: bigint;
  reserved: bigint;
}

export interface JudgeInput {
  fakeState: Pick<FakeState, "grants">;
  redemptions: JudgedRedemption[];
  balances: JudgedBalance[];
}

export function judge(input: JudgeInput): string[] {
  const problems: string[] = [];
  const byId = new Map(input.redemptions.map((r) => [r.id, r]));

  // More than one grant for one reference, in one tenant.
  const grantsOf = new Map<string, number>();
  for (const g of input.fakeState.grants) {
    const key = `${g.tenantId}|${g.reference}`;
    grantsOf.set(key, (grantsOf.get(key) ?? 0) + 1);
  }
  for (const [key, n] of grantsOf) {
    if (n > 1) problems.push(`reference ${key} was granted ${n} times (must be once)`);
  }

  for (const g of input.fakeState.grants) {
    const r = byId.get(g.reference);
    if (!r) {
      problems.push(`grant ${g.platformRef} has reference ${g.reference}, which is no redemption of ours`);
      continue;
    }
    if (g.tenantId !== r.tenantId || g.playerId !== r.externalPlayerId) {
      problems.push(
        `grant ${g.platformRef} went to ${g.tenantId}/${g.playerId}, the redemption belongs to ${r.tenantId}/${r.externalPlayerId}`,
      );
    }
    if (r.status === "refused" || r.status === "insufficient") {
      problems.push(`redemption ${r.id} is ${r.status} but the casino granted a reward for it`);
    }
  }

  for (const r of input.redemptions) {
    if (r.status === "issued" && !(grantsOf.get(`${r.tenantId}|${r.id}`) ?? 0)) {
      problems.push(`redemption ${r.id} is shown as issued but the casino has no grant for it`);
    }
  }

  for (const b of input.balances) {
    const who = `${b.tenantId}/${b.externalPlayerId}`;
    if (b.available < 0n) problems.push(`${who} has a negative balance (${b.available})`);
    if (b.reserved < 0n) problems.push(`${who} has negative reserved coins (${b.reserved})`);
    const mine = input.redemptions.filter(
      (r) => r.tenantId === b.tenantId && r.externalPlayerId === b.externalPlayerId,
    );
    const quiet = mine.every(
      (r) => r.status === "insufficient" || ((r.status === "issued" || r.status === "refused") && r.settled),
    );
    if (!quiet) continue;
    // Everything has settled: coins are gone exactly for the rewards that were issued, and nothing is held.
    const spent = mine.filter((r) => r.status === "issued").reduce((sum, r) => sum + r.costCoins, 0n);
    if (b.available !== b.creditedCoins - spent) {
      problems.push(
        `${who}: available is ${b.available}, expected ${b.creditedCoins} credited minus ${spent} spent on issued rewards`,
      );
    }
    if (b.reserved !== 0n)
      problems.push(`${who}: ${b.reserved} coins are still reserved though all is settled`);
  }
  return problems;
}

export interface JudgedPlayer {
  tenantId: string;
  externalId: string;
  creditedCoins: bigint;
}

/** Gathers the judge's input: redemptions by SQL, balances from the ledger, grants from the fake over HTTP. */
export async function collect(
  running: Pick<TestApp, "db" | "app">,
  fake: { url: string },
  players: JudgedPlayer[],
): Promise<JudgeInput> {
  const ledger = (running.app as INestApplication).get<CoinLedger>(COIN_LEDGER);
  const redemptions: JudgedRedemption[] = [];
  const balances: JudgedBalance[] = [];
  for (const p of players) {
    const found = await running.db.query(
      `SELECT r.id, r.status, r.settled_at, r.cost_coins, p.id AS player_id, t.ledger_no
       FROM redemptions r JOIN players p ON p.id = r.player_id JOIN tenants t ON t.id = r.tenant_id
       WHERE r.tenant_id = $1 AND p.external_id = $2`,
      [p.tenantId, p.externalId],
    );
    for (const r of found.rows) {
      redemptions.push({
        id: r.id,
        tenantId: p.tenantId,
        externalPlayerId: p.externalId,
        status: r.status,
        settled: r.settled_at !== null,
        costCoins: BigInt(r.cost_coins),
      });
    }
    const who = await running.db.query(
      `SELECT p.id, t.ledger_no FROM players p JOIN tenants t ON t.id = p.tenant_id
       WHERE p.tenant_id = $1 AND p.external_id = $2`,
      [p.tenantId, p.externalId],
    );
    const row = who.rows[0];
    if (!row) throw new Error(`no player ${p.tenantId}/${p.externalId}`);
    const balance = await ledger.balance({ ledgerNo: row.ledger_no, playerId: row.id });
    balances.push({
      tenantId: p.tenantId,
      externalPlayerId: p.externalId,
      creditedCoins: p.creditedCoins,
      ...balance,
    });
  }
  const state = (await (await fetch(`${fake.url}/control/state`)).json()) as FakeState;
  const mine = new Set(players.map((p) => `${p.tenantId}|${p.externalId}`));
  const ours = new Set(redemptions.map((r) => r.id));
  // Only grants of the players under judgement (or for our redemptions, whoever got them): one fake
  // serves the whole test file.
  const grants = state.grants.filter((g) => mine.has(`${g.tenantId}|${g.playerId}`) || ours.has(g.reference));
  return { fakeState: { grants }, redemptions, balances };
}
