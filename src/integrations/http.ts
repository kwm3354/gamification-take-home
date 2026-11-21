import { PlatformUnreachable, type TenantConnection } from "../domain/casino-platform.ts";

/** Used when the caller does not say how long a call may take. Normally env PLATFORM_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 2000;

/** The connection plus the time limit of one call. The domain type has no such field, so it is added here. */
export type TimedConnection = TenantConnection & { timeoutMs?: number };

export interface PlatformReply {
  status: number;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown;
  /** From a Retry-After header in seconds. */
  retryAfterMs?: number;
}

/**
 * One outgoing call with a time limit that really cancels the request (AbortController). The limit
 * covers connecting, the headers and reading the body. A timeout, a broken connection or a bad URL
 * all become PlatformUnreachable: the outcome is unknown and the caller must look before repeating.
 */
export async function callPlatform(
  conn: TimedConnection,
  method: "GET" | "POST",
  path: string,
  options: { headers?: Record<string, string>; json?: unknown } = {},
): Promise<PlatformReply> {
  const limit = conn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${conn.platformUrl.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    const header = response.headers.get("retry-after");
    const seconds = Number(header);
    const retryAfterMs =
      header !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
    return { status: response.status, body, retryAfterMs };
  } catch (e) {
    if (controller.signal.aborted)
      throw new PlatformUnreachable(`${method} ${path}: no answer in ${limit} ms`);
    throw new PlatformUnreachable(
      `${method} ${path}: connection failed (${e instanceof Error ? e.message : String(e)})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** An answer the contract does not list. Never "refused": an unknown answer must not move any coins. */
export function unexpectedAnswer(what: string, reply: PlatformReply): PlatformUnreachable {
  return new PlatformUnreachable(
    `${what}: unexpected answer, status ${reply.status}`,
    reply.status === 429 ? reply.retryAfterMs : undefined,
  );
}
