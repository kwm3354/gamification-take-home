import { describe, expect, it } from "vitest";
import type { LogEntry } from "../types.ts";
import { type KeyValueStorage, MESSAGES, createAuth } from "./auth.ts";

class MemoryStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const user = { id: "u1", email: "manager@alpha.demo", name: "Alpha manager", role: "tenant_admin", tenantId: "alpha-casino" };

function setup(reply: { status: number; body?: unknown } | "network", now = 1_000_000) {
  const storage = new MemoryStorage();
  const records: Omit<LogEntry, "id">[] = [];
  const fetchFn: typeof fetch = async () => {
    if (reply === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status });
  };
  const auth = createAuth({ fetch: fetchFn, record: (e) => records.push(e), now: () => now }, storage);
  return { auth, storage, records };
}

const good = { status: 200, body: { token: "tok", expiresAt: new Date(1_000_000 + 30 * 60_000).toISOString(), user } };

describe("sign-in state machine", () => {
  it("starts signed out", () => {
    expect(setup(good).auth.getState()).toEqual({ kind: "signedOut", notice: null, error: null, busy: false });
  });

  it("signs in, keeps the token in memory and in storage", async () => {
    const { auth, storage } = setup(good);
    await auth.signIn("manager@alpha.demo", "x");
    const state = auth.getState();
    expect(state.kind).toBe("signedIn");
    expect(auth.token()).toBe("tok");
    expect(storage.data.size).toBe(1);
  });

  it("answers 401 with one plain message and stores nothing", async () => {
    const { auth, storage } = setup({ status: 401, body: { message: "Unauthorized" } });
    await auth.signIn("a@b.c", "wrong");
    expect(auth.getState()).toEqual({ kind: "signedOut", notice: null, error: MESSAGES.wrong, busy: false });
    expect(storage.data.size).toBe(0);
  });

  it("says plainly when the service does not answer", async () => {
    const { auth } = setup("network");
    await auth.signIn("a@b.c", "x");
    expect(auth.getState()).toMatchObject({ kind: "signedOut", error: MESSAGES.unreachable });
  });

  it("ends the session on a later 401 and clears storage", async () => {
    const { auth, storage } = setup(good);
    await auth.signIn("manager@alpha.demo", "x");
    auth.sessionEnded();
    expect(auth.getState()).toEqual({ kind: "signedOut", notice: MESSAGES.ended, error: null, busy: false });
    expect(auth.token()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("ignores a late 401 when already signed out", async () => {
    const { auth } = setup(good);
    const before = auth.getState();
    auth.sessionEnded();
    expect(auth.getState()).toBe(before);
  });

  it("sign out clears sessionStorage and the token", async () => {
    const { auth, storage } = setup(good);
    await auth.signIn("manager@alpha.demo", "x");
    auth.signOut();
    expect(auth.getState().kind).toBe("signedOut");
    expect(auth.token()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("restores a saved session on reload, but not an expired one", async () => {
    const first = setup(good);
    await first.auth.signIn("manager@alpha.demo", "x");
    const saved = first.storage.data.get([...first.storage.data.keys()][0] ?? "") ?? "";

    const fresh = new MemoryStorage();
    fresh.setItem("backoffice-session-v1", saved);
    const reloaded = createAuth({ fetch, record: () => {}, now: () => 1_000_000 + 60_000 }, fresh);
    expect(reloaded.getState().kind).toBe("signedIn");

    const late = new MemoryStorage();
    late.setItem("backoffice-session-v1", saved);
    const expired = createAuth({ fetch, record: () => {}, now: () => 1_000_000 + 31 * 60_000 }, late);
    expect(expired.getState().kind).toBe("signedOut");
    expect(late.data.size).toBe(0);
  });
});
