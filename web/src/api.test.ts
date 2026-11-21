import { describe, expect, it } from "vitest";
import { type ClientDeps, playerRequest, tokenExpiry } from "./api.ts";
import type { LogEntry, Player } from "./types.ts";

interface Call {
  url: string;
  auth: string | undefined;
}

function stub(answers: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const log: Omit<LogEntry, "id">[] = [];
  const fetchStub = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const next = answers.shift();
    if (!next) throw new Error("no answer prepared");
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  const deps: ClientDeps = { fetch: fetchStub, record: (e) => log.push(e), now: () => 0 };
  return { deps, calls, log };
}

const player: Player = { key: "t:p", tenantId: "t", externalId: "p", token: "old", expiresAt: 0 };
const spec = { method: "GET", url: "http://app/me" };

describe("playerRequest", () => {
  it("on 401 gets a fresh token and repeats the call once", async () => {
    const { deps, calls } = stub([
      { status: 401, body: {} },
      { status: 200, body: { token: "new" } },
      { status: 200, body: { ok: 1 } },
    ]);
    const seen: string[] = [];
    const res = await playerRequest(
      deps,
      { fakeCasinoUrl: "http://fake", player, onToken: (t) => seen.push(t) },
      spec,
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["new"]);
    expect(calls.map((c) => c.url)).toEqual(["http://app/me", "http://fake/control/token", "http://app/me"]);
    expect(calls[0]?.auth).toBe("Bearer old");
    expect(calls[2]?.auth).toBe("Bearer new");
  });

  it("repeats only once: a second 401 is returned, with no third call", async () => {
    const { deps, calls } = stub([
      { status: 401, body: {} },
      { status: 200, body: { token: "new" } },
      { status: 401, body: {} },
    ]);
    const res = await playerRequest(deps, { fakeCasinoUrl: "http://fake", player, onToken: () => {} }, spec);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(3);
  });

  it("does not ask for a token when the first answer is not 401", async () => {
    const { deps, calls } = stub([{ status: 500, body: {} }]);
    const res = await playerRequest(deps, { fakeCasinoUrl: "http://fake", player, onToken: () => {} }, spec);
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("writes every call to the log, including the token call", async () => {
    const { deps, log } = stub([
      { status: 401, body: {} },
      { status: 200, body: { token: "new" } },
      { status: 200, body: {} },
    ]);
    await playerRequest(deps, { fakeCasinoUrl: "http://fake", player, onToken: () => {} }, spec);
    expect(log.map((e) => e.actor)).toEqual(["player -> us", "page -> casino", "player -> us"]);
  });

  it("returns a result with status 0 when the network fails", async () => {
    const deps: ClientDeps = {
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
      record: () => {},
      now: () => 0,
    };
    const res = await playerRequest(deps, { fakeCasinoUrl: "http://fake", player, onToken: () => {} }, spec);
    expect(res.status).toBe(0);
    expect(res.networkError).toBe("down");
  });
});

describe("tokenExpiry", () => {
  it("reads exp in milliseconds", () => {
    const payload = btoa(JSON.stringify({ exp: 1000 })).replaceAll("=", "");
    expect(tokenExpiry(`h.${payload}.s`)).toBe(1_000_000);
    expect(tokenExpiry("garbage")).toBe(0);
  });
});
