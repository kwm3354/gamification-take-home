import type { Actor, LogEntry, Player } from "./types.ts";

export interface ClientDeps {
  fetch: typeof fetch;
  record: (entry: Omit<LogEntry, "id">) => void;
  now: () => number;
}

export interface RequestSpec {
  actor: Actor;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  tag?: string;
}

export interface Result {
  /** 0 when no answer came. */
  status: number;
  ok: boolean;
  body: unknown;
  networkError: string | null;
}

/** One HTTP call. Never throws. Every call is written to the request log. */
export async function request(deps: ClientDeps, spec: RequestSpec): Promise<Result> {
  const headers: Record<string, string> = { ...spec.headers };
  const requestBody = spec.body === undefined ? null : JSON.stringify(spec.body);
  if (requestBody !== null) headers["Content-Type"] = "application/json";
  const started = deps.now();
  let result: Result;
  let responseBody: string | null = null;
  try {
    const res = await deps.fetch(spec.url, {
      method: spec.method,
      headers,
      ...(requestBody === null ? {} : { body: requestBody }),
    });
    responseBody = await res.text();
    let parsed: unknown = responseBody;
    try {
      parsed = responseBody === "" ? null : JSON.parse(responseBody);
    } catch {
      // keep the text
    }
    result = { status: res.status, ok: res.ok, body: parsed, networkError: null };
  } catch (err) {
    result = {
      status: 0,
      ok: false,
      body: null,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
  deps.record({
    at: started,
    actor: spec.actor,
    method: spec.method,
    url: spec.url,
    status: result.status === 0 ? null : result.status,
    durationMs: Math.max(0, deps.now() - started),
    requestHeaders: headers,
    requestBody,
    responseBody,
    error: result.networkError,
    tag: spec.tag ?? null,
  });
  return result;
}

export interface PlayerSession {
  fakeCasinoUrl: string;
  player: Player;
  /** Called when a fresh token was fetched after a 401. */
  onToken: (token: string, expiresAt: number) => void;
}

/** The expiry of a token in ms, from its `exp` claim; 0 when it cannot be read. */
export function tokenExpiry(token: string): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export async function fetchToken(
  deps: ClientDeps,
  fakeCasinoUrl: string,
  tenantId: string,
  playerId: string,
): Promise<{ token: string; expiresAt: number } | null> {
  const res = await request(deps, {
    actor: "page -> casino",
    method: "POST",
    url: `${fakeCasinoUrl}/control/token`,
    body: { tenantId, playerId },
  });
  const token = (res.body as { token?: unknown } | null)?.token;
  return res.ok && typeof token === "string" ? { token, expiresAt: tokenExpiry(token) } : null;
}

/**
 * A call as the player. On 401 it gets a fresh token from the casino and repeats the call once.
 * If the repeat is also 401, that answer is returned.
 */
export async function playerRequest(
  deps: ClientDeps,
  session: PlayerSession,
  spec: Omit<RequestSpec, "actor">,
): Promise<Result> {
  const send = (token: string) =>
    request(deps, {
      ...spec,
      actor: "player -> us",
      headers: { ...spec.headers, Authorization: `Bearer ${token}` },
    });
  const first = await send(session.player.token);
  if (first.status !== 401) return first;
  const fresh = await fetchToken(
    deps,
    session.fakeCasinoUrl,
    session.player.tenantId,
    session.player.externalId,
  );
  if (!fresh) return first;
  session.onToken(fresh.token, fresh.expiresAt);
  return send(fresh.token);
}

/** A short sentence for a failed call. */
export function describeFailure(res: Result): string {
  if (res.status === 0) return "The service did not answer.";
  const body = res.body as { message?: unknown; error?: unknown } | null;
  const detail =
    typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "";
  return detail ? `The service answered ${res.status}: ${detail}.` : `The service answered ${res.status}.`;
}
