import type { StoreItem } from "./types.ts";

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

export function money(amountMinor: number, currency: string): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const major = amountMinor / 100;
  return `${symbol}${Number.isInteger(major) ? major : major.toFixed(2)}`;
}

/** The reward name a player reads, for example "Bonus €5". */
export function rewardTitle(item: StoreItem): string {
  const kind = item.reward.type.charAt(0).toUpperCase() + item.reward.type.slice(1);
  return `${kind} ${money(item.reward.amountMinor, item.reward.currency)}`;
}

export function coins(value: string | number): string {
  return Number(value).toLocaleString("en-US");
}
