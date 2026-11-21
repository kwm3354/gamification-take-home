import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The back office token: a JWT, HS256, signed with the server's own secret. Plain code.
 * Claims: sub (user id), role, tid (tenant id or null), name, iat, exp (30 minutes), aud "backoffice".
 */
export const ADMIN_AUDIENCE = "backoffice";
export const ADMIN_TOKEN_SECONDS = 30 * 60;

export interface AdminClaims {
  sub: string;
  role: string;
  tid: string | null;
  name: string;
  iat: number;
  exp: number;
  aud: string;
}

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (secret: string, data: string): Buffer => createHmac("sha256", secret).update(data).digest();

function parse(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function signAdminToken(
  secret: string,
  now: Date,
  user: { id: string; role: string; tenantId: string | null; name: string },
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ADMIN_TOKEN_SECONDS;
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({
    sub: user.id,
    role: user.role,
    tid: user.tenantId,
    name: user.name,
    iat,
    exp,
    aud: ADMIN_AUDIENCE,
  } satisfies AdminClaims);
  const signature = sign(secret, `${head}.${body}`).toString("base64url");
  return { token: `${head}.${body}.${signature}`, expiresAt: new Date(exp * 1000) };
}

/** The claims, or null for any failure. Callers must not say which check failed. */
export function verifyAdminToken(secret: string, token: string, now: Date): AdminClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = parse(h);
  const payload = parse(p);
  if (!header || !payload || header.alg !== "HS256") return null;
  const expected = sign(secret, `${h}.${p}`);
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (payload.aud !== ADMIN_AUDIENCE) return null;
  const seconds = now.getTime() / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
  if (payload.exp > seconds + ADMIN_TOKEN_SECONDS) return null;
  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  if (typeof payload.role !== "string") return null;
  if (payload.tid !== null && typeof payload.tid !== "string") return null;
  return {
    sub: payload.sub,
    role: payload.role,
    tid: payload.tid as string | null,
    name: typeof payload.name === "string" ? payload.name : "",
    iat: typeof payload.iat === "number" ? payload.iat : 0,
    exp: payload.exp,
    aud: ADMIN_AUDIENCE,
  };
}
