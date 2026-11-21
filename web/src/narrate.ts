import type { LogEntry } from "./types.ts";

/** One sentence of the "behind the scenes" timeline. It is built from a real call and its answer. */
export interface Line {
  id: string;
  text: string;
  /** False when the call failed or the answer was a refusal. */
  ok: boolean;
  entry: LogEntry;
}

type Json = Record<string, unknown>;

function parse(text: string | null): Json | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

const path = (e: LogEntry): string => {
  try {
    return new URL(e.url).pathname;
  } catch {
    return e.url;
  }
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function failure(e: LogEntry): string {
  if (e.status === null) return "no answer";
  return `answer ${e.status}`;
}

/**
 * Turns the request log (oldest first) into sentences. `titles` maps a store item id to its name.
 * Repeated reads of a redemption add a line only when its status changed.
 */
export function buildTimeline(entries: LogEntry[], titles: Record<string, string>): Line[] {
  const lines: Line[] = [];
  const seen = new Map<string, string>();
  const add = (e: LogEntry, n: number, text: string, ok = true) =>
    lines.push({ id: `${e.id}-${n}`, text, ok, entry: e });

  /** The lines for what the casino did with a redemption, from its current status. */
  const outcome = (e: LogEntry, n: number, data: Json) => {
    const status = String(data.status);
    if (status === "submitting") {
      add(
        e,
        n,
        data.platformRef
          ? "The casino accepted and will confirm in a moment"
          : "The casino has not answered yet; we keep asking",
      );
    } else if (status === "issued") {
      add(
        e,
        n,
        data.settled
          ? "The casino confirmed; the coins were spent"
          : "The casino confirmed; the coins are being settled",
      );
    } else if (status === "refused") {
      add(e, n, "The casino refused; your coins came back", false);
    }
  };

  for (const e of entries) {
    const p = path(e);
    const req = parse(e.requestBody);
    const res = parse(e.responseBody);
    const sentOk = e.status !== null && e.status >= 200 && e.status < 300;

    if (e.method === "POST" && p === "/control/deposit") {
      const sent = Array.isArray(res?.sent)
        ? (res?.sent[0] as { status?: number; body?: Json } | undefined)
        : undefined;
      const amount = typeof req?.amount === "string" ? req.amount : "an amount";
      if (!sentOk || !sent) {
        add(e, 0, `The casino could not send us the deposit (${failure(e)})`, false);
      } else if (sent.status === 200) {
        const body = sent.body ?? {};
        if (Number(body.accepted) > 0) {
          add(e, 0, `The casino told us about a deposit of ${amount}`);
          add(e, 1, "We checked the casino's signature: it is valid");
          add(e, 2, "We recorded the deposit");
        } else if (Number(body.duplicates) > 0) {
          add(e, 0, "The casino sent a deposit we had already seen, so nothing changed");
        } else {
          add(e, 0, "We ignored the casino's message: it was not a completed deposit");
        }
      } else {
        add(e, 0, `The casino told us about a deposit of ${amount}`);
        add(e, 1, `We refused it (answer ${sent.status ?? "none"}); nothing changed`, false);
      }
    } else if (e.method === "GET" && p === "/me" && e.tag === "after-deposit") {
      if (!sentOk) add(e, 0, `We could not read your spins (${failure(e)})`, false);
      else {
        const spins = Array.isArray(res?.spins)
          ? (res.spins as { status?: string }[]).filter((s) => s.status === "available").length
          : 0;
        add(
          e,
          0,
          spins > 0
            ? `We gave you a spin: you now have ${plural(spins, "spin", "spins")}`
            : "No spin was added for this deposit",
        );
      }
    } else if (e.method === "POST" && /^\/wheel\/spins\/[^/]+\/spin$/.test(p)) {
      if (!sentOk)
        add(
          e,
          0,
          `You pressed Spin, but the game did not confirm it (${failure(e)}); your spin is not lost`,
          false,
        );
      else
        add(
          e,
          0,
          `You pressed Spin; the server picked the prize, not your browser: ${String(res?.label ?? "a prize")}`,
        );
    } else if (e.method === "GET" && p === "/me" && e.tag === "after-spin") {
      const balance = res?.balance as { available?: string } | null | undefined;
      if (!sentOk) add(e, 0, `We could not read your balance (${failure(e)})`, false);
      else if (!balance) add(e, 0, "The ledger did not answer, so your balance is not shown yet", false);
      else add(e, 0, `The prize was paid in the ledger: your balance is now ${balance.available} coins`);
    } else if (e.method === "POST" && p === "/store/redemptions") {
      const title = titles[String(req?.itemId)] ?? "a reward";
      if (!sentOk || !res) {
        add(e, 0, `You asked for ${title}, but the request failed (${failure(e)}); nothing was taken`, false);
      } else if (res.status === "insufficient") {
        add(e, 0, `You asked for ${title}, but you did not have enough coins; nothing was taken`, false);
      } else {
        add(e, 0, `You asked for ${title}; we set ${res.costCoins} coins aside`);
        const status = String(res.status);
        if (status === "submitting" || status === "issued" || status === "refused") {
          add(e, 1, "We asked the casino to issue it");
        } else {
          add(e, 1, "We are still working on it");
        }
        outcome(e, 2, res);
        seen.set(String(res.id), status);
      }
    } else if (e.method === "GET" && /^\/store\/redemptions\/[^/]+$/.test(p)) {
      if (sentOk && res) {
        const status = String(res.status);
        if (seen.get(String(res.id)) !== status) {
          seen.set(String(res.id), status);
          if (status === "submitting") add(e, 0, "We asked the casino to issue it");
          outcome(e, 1, res);
        }
      }
    } else if (e.method === "POST" && p === "/control/token") {
      if (sentOk) add(e, 0, "The casino vouched for the player with a short-lived signed pass");
      else add(e, 0, `The casino could not give the player a pass (${failure(e)})`, false);
    } else if (!sentOk && e.actor !== "admin -> us" && e.method !== "GET") {
      add(e, 0, `A request to ${p} failed (${failure(e)})`, false);
    }
  }
  return lines;
}
