import { describe, expect, it } from "vitest";
import { LOG_LIMIT, initialState, persistedOf, reducer } from "./state.ts";
import type { CasinoTenant, LogEntry, Player } from "./types.ts";

const tenants: CasinoTenant[] = [
  { id: "alpha-casino", name: "Alpha Casino", platform: "A", adminKey: "k-a" },
  { id: "beta-casino", name: "Beta Casino", platform: "B", adminKey: "k-b" },
];

const player = (tenantId: string, externalId: string): Player => ({
  key: `${tenantId}:${externalId}`,
  tenantId,
  externalId,
  token: "t",
  expiresAt: 1,
});

const entry = (id: number): LogEntry => ({
  id,
  at: id,
  actor: "player -> us",
  method: "GET",
  url: "http://x/me",
  status: 200,
  durationMs: 1,
  requestHeaders: {},
  requestBody: null,
  responseBody: null,
  error: null,
  tag: null,
});

describe("reducer", () => {
  const ready = reducer(initialState, { type: "config", fakeCasinoUrl: "http://f", tenants });

  it("picks the first casino and fills in the demo admin keys once the config arrives", () => {
    expect(ready.boot).toBe("ready");
    expect(ready.tenantId).toBe("alpha-casino");
    expect(ready.adminKeys).toEqual({ "alpha-casino": "k-a", "beta-casino": "k-b" });
  });

  it("adds a player and makes it the current one", () => {
    const s = reducer(ready, { type: "addPlayer", player: player("alpha-casino", "p-1") });
    expect(s.currentKey).toBe("alpha-casino:p-1");
    expect(s.players).toHaveLength(1);
  });

  it("switches casino and returns to that casino's last player, or to none", () => {
    let s = reducer(ready, { type: "addPlayer", player: player("alpha-casino", "p-1") });
    s = reducer(s, { type: "switchTenant", tenantId: "beta-casino" });
    expect(s.tenantId).toBe("beta-casino");
    expect(s.currentKey).toBeNull();
    s = reducer(s, { type: "switchTenant", tenantId: "alpha-casino" });
    expect(s.currentKey).toBe("alpha-casino:p-1");
  });

  it("records a redemption once and updates its status from the server", () => {
    const tracked = {
      id: "r1",
      playerKey: "alpha-casino:p-1",
      tenantId: "alpha-casino",
      itemName: "Bonus €1",
      createdAt: 1,
    };
    let s = reducer(ready, { type: "track", tracked, data: null });
    s = reducer(s, { type: "track", tracked, data: null });
    expect(s.tracked).toHaveLength(1);
    s = reducer(s, {
      type: "redemption",
      data: { id: "r1", status: "issued", costCoins: "100", reason: null },
    });
    expect(s.tracked[0]?.data?.status).toBe("issued");
  });

  it("keeps the newest 300 log entries, newest first", () => {
    let s = ready;
    for (let i = 1; i <= LOG_LIMIT + 25; i++) s = reducer(s, { type: "log", entry: entry(i) });
    expect(s.log).toHaveLength(LOG_LIMIT);
    expect(s.log[0]?.id).toBe(LOG_LIMIT + 25);
  });

  it("keeps only ids, never statuses or balances, in the saved part", () => {
    let s = reducer(ready, { type: "addPlayer", player: player("alpha-casino", "p-1") });
    s = reducer(s, {
      type: "track",
      tracked: {
        id: "r1",
        playerKey: "alpha-casino:p-1",
        tenantId: "alpha-casino",
        itemName: "x",
        createdAt: 1,
      },
      data: { id: "r1", status: "issued", costCoins: "1", reason: null },
    });
    s = reducer(s, {
      type: "me",
      key: "alpha-casino:p-1",
      me: { playerId: "u", tenantId: "alpha-casino", balance: { available: "5", reserved: "0" }, spins: [] },
    });
    const text = JSON.stringify(persistedOf(s));
    expect(text).not.toContain("issued");
    expect(text).not.toContain('"available"');
  });

  it("a saved session from another tab replaces players and redemptions but keeps server data", () => {
    let s = reducer(ready, { type: "addPlayer", player: player("alpha-casino", "p-1") });
    s = reducer(s, {
      type: "me",
      key: "alpha-casino:p-1",
      me: { playerId: "u", tenantId: "alpha-casino", balance: null, spins: [] },
    });
    s = reducer(s, {
      type: "hydrate",
      persisted: {
        tenantId: "beta-casino",
        players: [player("beta-casino", "p-2")],
        currentKey: "beta-casino:p-2",
        adminName: "me",
        redemptions: [],
      },
    });
    expect(s.players.map((p) => p.externalId)).toEqual(["p-2"]);
    expect(s.tenantId).toBe("beta-casino");
    expect(s.adminName).toBe("me");
  });
});
