import { useSyncExternalStore } from "react";
import { type ClientDeps, type Result, describeFailure, request } from "../api.ts";
import type { LogEntry } from "../types.ts";
import { type Auth, type AuthState, createAuth } from "./auth.ts";
import type { Role } from "./roles.ts";

/** What the "Requests" panel shows. No bodies, no headers, so no token. */
export interface CallRecord {
  id: number;
  at: number;
  method: string;
  path: string;
  status: number | null;
  ms: number;
}

const LIMIT = 200;
let nextId = 0;
let calls: CallRecord[] = [];
const listeners = new Set<() => void>();

/** The only fields of a call that the panel keeps. Headers (the token) and bodies (the password) are dropped. */
export function toCallRecord(entry: Omit<LogEntry, "id">, id: number): CallRecord {
  let path = entry.url;
  try {
    const u = new URL(entry.url, "http://local");
    path = u.pathname + u.search;
  } catch {
    // keep the text
  }
  return { id, at: entry.at, method: entry.method, path, status: entry.status, ms: entry.durationMs };
}

const deps: ClientDeps = {
  fetch: (input, init) => window.fetch(input, init),
  now: () => Date.now(),
  record: (entry) => {
    calls = [toCallRecord(entry, ++nextId), ...calls].slice(0, LIMIT);
    for (const l of listeners) l();
  },
};

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let authSingleton: Auth | null = null;

/** The one sign-in controller of the page. Created on first use. */
export function auth(): Auth {
  authSingleton ??= createAuth(deps, storage());
  return authSingleton;
}

export function useAuth(): AuthState {
  const a = auth();
  return useSyncExternalStore(a.subscribe, a.getState);
}

export function useCalls(): CallRecord[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => calls,
  );
}

/** A call to our API as the signed-in admin. A 401 ends the session. */
export async function adminCall(method: string, path: string, body?: unknown): Promise<Result> {
  const a = auth();
  const token = a.token();
  const res = await request(deps, {
    actor: "admin -> us",
    method,
    url: path,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    ...(body === undefined ? {} : { body }),
  });
  if (res.status === 401) a.sessionEnded();
  return res;
}

export const tenantPath = (tenantId: string, rest: string): string =>
  `/admin/${encodeURIComponent(tenantId)}${rest}`;

/** A short sentence for a failed call. The server decides; the page only explains. */
export function describeAdminFailure(res: Result): string {
  if (res.status === 403) return "Your role is not allowed to do this.";
  if (res.status === 404) return "Not found for this tenant.";
  return describeFailure(res);
}

export interface DemoAdmin {
  email: string;
  password: string;
  role: Role;
  tenantId: string | null;
}

/** Demo users from `/app-config.json` (`demoAdmins`). Empty when the field is absent. */
export async function loadDemoAdmins(): Promise<DemoAdmin[]> {
  try {
    const res = await window.fetch("/app-config.json");
    const body = (await res.json()) as { demoAdmins?: unknown };
    if (!Array.isArray(body.demoAdmins)) return [];
    return body.demoAdmins.filter(
      (x): x is DemoAdmin =>
        typeof x === "object" && x !== null && typeof x.email === "string" && typeof x.password === "string",
    );
  } catch {
    return [];
  }
}
