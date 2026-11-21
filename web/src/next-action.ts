import type { Me, StoreItem } from "./types.ts";

/** The one thing the player should do next, and the sentence that says why. */
export type NextAction =
  | { kind: "wait"; why: string }
  | { kind: "spin"; spins: number; why: string }
  | { kind: "reward"; itemId: string; why: string }
  | { kind: "deposit"; why: string };

/**
 * Spin first, because a spin is free and gives coins. A reward comes next: the most expensive one
 * the coins can pay for. With neither, the player goes to the cashier.
 */
export function nextAction(
  me: Me | null,
  items: StoreItem[],
  title: (item: StoreItem) => string,
): NextAction {
  if (!me) return { kind: "wait", why: "Getting your game ready" };
  const spins = me.spins.filter((s) => s.status === "available").length;
  if (spins > 0) {
    return {
      kind: "spin",
      spins,
      why: spins === 1 ? "You have a spin. Press Spin." : `You have ${spins} spins. Press Spin.`,
    };
  }
  const available = Number(me.balance?.available ?? 0);
  const affordable = items
    .filter((i) => Number(i.costCoins) <= available)
    .sort((a, b) => Number(b.costCoins) - Number(a.costCoins));
  const best = affordable[0];
  if (best) return { kind: "reward", itemId: best.id, why: `You have enough coins for ${title(best)}.` };
  return { kind: "deposit", why: "No spins left. Deposit to get a spin." };
}
