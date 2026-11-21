import { createHmac, timingSafeEqual } from "node:crypto";
import { type Tenant, activeTokenSecrets } from "./tenants.ts";

const MAX_AHEAD_SECONDS = 15 * 60;

const b64 = (s: string): Buffer => Buffer.from(s, "base64url");

function json(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(b64(part).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Checks an HS256 player token. The tenant is named by the unverified `iss`, then the signature is
 * checked with that tenant's secret. Returns null for any failure; callers must not say which check failed.
 */
export async function verifyPlayerToken(
  token: string,
  now: Date,
  loadTenant: (id: string) => Promise<Tenant | null>,
): Promise<{ tenant: Tenant; externalId: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = json(h);
  const payload = json(p);
  if (!header || !payload || header.alg !== "HS256") return null;
  if (typeof payload.iss !== "string" || payload.iss === "") return null;
  const tenant = await loadTenant(payload.iss);
  if (!tenant) return null;
  const given = b64(s);
  let signed = false;
  for (const secret of activeTokenSecrets(tenant, now)) {
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) signed = true;
  }
  if (!signed) return null;
  const nowSeconds = now.getTime() / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (payload.exp > nowSeconds + MAX_AHEAD_SECONDS) return null;
  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  return { tenant, externalId: payload.sub };
}
