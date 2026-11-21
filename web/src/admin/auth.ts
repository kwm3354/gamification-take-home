import { type ClientDeps, describeFailure, request } from "../api.ts";
import type { Role } from "./roles.ts";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
}

export interface Session {
  token: string;
  /** ISO time from the server. */
  expiresAt: string;
  user: AdminUser;
}

export type AuthState =
  | { kind: "signedOut"; notice: string | null; error: string | null; busy: boolean }
  | { kind: "signedIn"; session: Session };

export type AuthEvent =
  | { type: "started" }
  | { type: "succeeded"; session: Session }
  | { type: "failed"; error: string }
  | { type: "ended" }
  | { type: "signedOut" };

export const SIGNED_OUT: AuthState = { kind: "signedOut", notice: null, error: null, busy: false };

export const MESSAGES = {
  wrong: "Wrong email or password, or the account is locked.",
  unreachable: "The service did not answer. Check that it is running, then try again.",
  ended: "Your session ended. Sign in again.",
} as const;

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "started":
      return { kind: "signedOut", notice: null, error: null, busy: true };
    case "succeeded":
      return { kind: "signedIn", session: event.session };
    case "failed":
      return { kind: "signedOut", notice: null, error: event.error, busy: false };
    case "ended":
      // A late 401 only matters while signed in.
      return state.kind === "signedIn"
        ? { kind: "signedOut", notice: MESSAGES.ended, error: null, busy: false }
        : state;
    case "signedOut":
      return SIGNED_OUT;
  }
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = "backoffice-session-v1";

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Session>;
  const u = v.user as Partial<AdminUser> | undefined;
  return (
    typeof v.token === "string" &&
    typeof v.expiresAt === "string" &&
    typeof u === "object" &&
    u !== null &&
    typeof u.id === "string" &&
    typeof u.role === "string" &&
    typeof u.email === "string" &&
    typeof u.name === "string"
  );
}

function readSession(storage: KeyValueStorage | null, now: number): Session | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isSession(value) && Date.parse(value.expiresAt) > now) return value;
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked. The token then lives in memory only.
  }
  return null;
}

export interface Auth {
  getState: () => AuthState;
  subscribe: (listener: () => void) => () => void;
  signIn: (email: string, password: string) => Promise<void>;
  /** Call when any later request answered 401. */
  sessionEnded: () => void;
  signOut: () => void;
  token: () => string | null;
}

/** Sign-in state. The token is kept in memory and in the given storage (sessionStorage in the app). */
export function createAuth(deps: ClientDeps, storage: KeyValueStorage | null): Auth {
  const saved = readSession(storage, deps.now());
  let state: AuthState = saved ? { kind: "signedIn", session: saved } : SIGNED_OUT;
  const listeners = new Set<() => void>();

  const apply = (event: AuthEvent) => {
    const next = authReducer(state, event);
    if (next === state) return;
    state = next;
    try {
      if (next.kind === "signedIn") storage?.setItem(STORAGE_KEY, JSON.stringify(next.session));
      else storage?.removeItem(STORAGE_KEY);
    } catch {
      // The app works without storage.
    }
    for (const l of listeners) l();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signIn(email, password) {
      apply({ type: "started" });
      const res = await request(deps, {
        actor: "admin -> us",
        method: "POST",
        url: "/admin/auth/login",
        body: { email, password },
      });
      if (res.status === 0) return apply({ type: "failed", error: MESSAGES.unreachable });
      if (res.status === 401) return apply({ type: "failed", error: MESSAGES.wrong });
      const body = res.body as Partial<Session> | null;
      if (!res.ok || !body || !isSession(body)) return apply({ type: "failed", error: describeFailure(res) });
      apply({ type: "succeeded", session: { token: body.token, expiresAt: body.expiresAt, user: body.user } });
    },
    sessionEnded: () => apply({ type: "ended" }),
    signOut: () => apply({ type: "signedOut" }),
    token: () => (state.kind === "signedIn" ? state.session.token : null),
  };
}
