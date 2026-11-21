import { demoAdmins } from "../src/tenants/demo-tenants.ts";
import type { TestApp } from "./app.ts";

export const OPS = "ops@demo.local";
export const ALPHA_MANAGER = "manager@alpha.demo";
export const ALPHA_VIEWER = "viewer@alpha.demo";
export const BETA_MANAGER = "manager@beta.demo";

export const passwordOf = (email: string): string => {
  const u = demoAdmins.find((a) => a.email === email);
  if (!u) throw new Error(`no demo admin ${email}`);
  return u.password;
};

/** Signs in over HTTP as a demo user (the seed must have run) and returns the token. */
export async function loginAs(
  running: Pick<TestApp, "url">,
  email: string,
  password?: string,
): Promise<string> {
  const r = await fetch(`${running.url}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: password ?? passwordOf(email) }),
  });
  if (r.status !== 200) throw new Error(`login as ${email} gave ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// Signing in costs a password hash, so a token is reused until 20 minutes of the app's clock have
// passed (a token lives for 30). The key includes the app address: every test file has its own app.
const cache = new Map<string, { token: string; at: number }>();

/** Headers for an admin call as this demo user. */
export async function adminHeaders(
  running: Pick<TestApp, "url" | "clock">,
  email: string,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const key = `${running.url}|${email}`;
  const now = running.clock.now().getTime();
  let hit = cache.get(key);
  if (!hit || now - hit.at > 20 * 60_000 || now < hit.at) {
    hit = { token: await loginAs(running, email), at: now };
    cache.set(key, hit);
  }
  return { ...bearer(hit.token), ...extra };
}

/** The user id of a demo user, as the audit trail names it (`admin/<id>`). */
export async function userIdOf(running: Pick<TestApp, "db">, email: string): Promise<string> {
  const r = await running.db.query("SELECT id FROM admin_users WHERE email = $1", [email]);
  return r.rows[0].id as string;
}
