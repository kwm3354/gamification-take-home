import { describe, expect, it } from "vitest";
import { buildTimeline } from "./narrate.ts";
import { nextAction } from "./next-action.ts";
import type { LogEntry, Me, StoreItem } from "./types.ts";

let id = 0;
function call(
  method: string,
  url: string,
  status: number | null,
  req: unknown,
  res: unknown,
  tag: string | null = null,
): LogEntry {
  return {
    id: ++id,
    at: id,
    actor: "player -> us",
    method,
    url,
    status,
    durationMs: 1,
    requestHeaders: {},
    requestBody: req === undefined ? null : JSON.stringify(req),
    responseBody: res === undefined ? null : JSON.stringify(res),
    error: null,
    tag,
  };
}

const titles = { i1: "Bonus €1" };
const texts = (entries: LogEntry[]) => buildTimeline(entries, titles).map((l) => l.text);

describe("buildTimeline", () => {
  it("narrates a good deposit in three steps", () => {
    const lines = texts([
      call(
        "POST",
        "http://f/control/deposit",
        200,
        { amount: "20.00" },
        { sent: [{ status: 200, body: { accepted: 1, duplicates: 0, ignored: 0 } }] },
      ),
    ]);
    expect(lines).toEqual([
      "The casino told us about a deposit of 20.00",
      "We checked the casino's signature: it is valid",
      "We recorded the deposit",
    ]);
  });

  it("says so when the signature was refused", () => {
    const lines = buildTimeline(
      [
        call(
          "POST",
          "http://f/control/deposit",
          200,
          { amount: "20.00" },
          { sent: [{ status: 401, body: {} }] },
        ),
      ],
      titles,
    );
    expect(lines[1]?.ok).toBe(false);
    expect(lines[1]?.text).toContain("401");
  });

  it("takes the spin count from the real answer", () => {
    const lines = texts([
      call(
        "GET",
        "http://a/me",
        200,
        undefined,
        { spins: [{ status: "available" }, { status: "used" }] },
        "after-deposit",
      ),
    ]);
    expect(lines).toEqual(["We gave you a spin: you now have 1 spin"]);
  });

  it("reports a failed spin as a problem and says the spin is not lost", () => {
    const [line] = buildTimeline([call("POST", "http://a/wheel/spins/s1/spin", 500, undefined, {})], titles);
    expect(line?.ok).toBe(false);
    expect(line?.text).toContain("not lost");
  });

  it("follows a platform B redemption from accepted to confirmed, one line per change", () => {
    const base = { id: "r1", costCoins: "100", platformRef: "r_1" };
    const lines = texts([
      call("POST", "http://a/store/redemptions", 201, { itemId: "i1" }, { ...base, status: "submitting" }),
      call("GET", "http://a/store/redemptions/r1", 200, undefined, { ...base, status: "submitting" }),
      call("GET", "http://a/store/redemptions/r1", 200, undefined, {
        ...base,
        status: "issued",
        settled: true,
      }),
      call("GET", "http://a/store/redemptions/r1", 200, undefined, {
        ...base,
        status: "issued",
        settled: true,
      }),
    ]);
    expect(lines).toEqual([
      "You asked for Bonus €1; we set 100 coins aside",
      "We asked the casino to issue it",
      "The casino accepted and will confirm in a moment",
      "The casino confirmed; the coins were spent",
    ]);
  });

  it("tells that coins came back when the casino refused", () => {
    const lines = buildTimeline(
      [
        call(
          "POST",
          "http://a/store/redemptions",
          201,
          { itemId: "i1" },
          { id: "r2", costCoins: "100", status: "refused" },
        ),
      ],
      titles,
    );
    expect(lines.at(-1)?.text).toBe("The casino refused; your coins came back");
    expect(lines.at(-1)?.ok).toBe(false);
  });

  it("says nothing was taken when the player had too few coins", () => {
    const [line] = buildTimeline(
      [
        call(
          "POST",
          "http://a/store/redemptions",
          201,
          { itemId: "i1" },
          { id: "r3", costCoins: "100", status: "insufficient" },
        ),
      ],
      titles,
    );
    expect(line?.text).toContain("nothing was taken");
  });
});

describe("nextAction", () => {
  const item = (id: string, cost: string): StoreItem => ({
    id,
    code: id,
    name: id,
    costCoins: cost,
    reward: { type: "bonus", currency: "EUR", amountMinor: 100 },
  });
  const me = (spins: number, available: string): Me => ({
    playerId: "u",
    tenantId: "t",
    balance: { available, reserved: "0" },
    spins: Array.from({ length: spins }, (_, i) => ({ id: String(i), status: "available", coins: null })),
  });
  const items = [item("a", "100"), item("b", "500")];
  const title = (i: StoreItem) => i.id;

  it("asks for a deposit when there is no spin and not enough coins", () => {
    expect(nextAction(me(0, "10"), items, title).kind).toBe("deposit");
  });
  it("asks to spin when a spin is available, even with coins", () => {
    expect(nextAction(me(2, "900"), items, title)).toMatchObject({ kind: "spin", spins: 2 });
  });
  it("points at the best reward the coins can pay for", () => {
    expect(nextAction(me(0, "150"), items, title)).toMatchObject({ kind: "reward", itemId: "a" });
    expect(nextAction(me(0, "600"), items, title)).toMatchObject({ kind: "reward", itemId: "b" });
  });
  it("waits while the player is not loaded", () => {
    expect(nextAction(null, items, title).kind).toBe("wait");
  });
});
