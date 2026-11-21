import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { signAdminToken } from "../src/admin/admin-token.ts";
import { hashPassword, verifyPassword } from "../src/admin/password.ts";
import { type Action, type AdminUser, can } from "../src/admin/permissions.ts";
import { create } from "../src/audit/audited.ts";
import { transaction } from "../src/db.ts";
import { demoAdmins, demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import {
  ALPHA_MANAGER,
  ALPHA_VIEWER,
  BETA_MANAGER,
  OPS,
  bearer,
  loginAs,
  passwordOf,
} from "./admin-login.ts";
import { TEST_ADMIN_TOKEN_SECRET, startApp } from "./app.ts";
import { tokenFor } from "./signing.ts";

const running = await startApp();
const ALPHA = "alpha-casino";
const BETA = "beta-casino";
const MINUTE = 60_000;

beforeAll(async () => {
  if (running) await seedDemo(running.db, running.clock, "http://127.0.0.1:1");
});
afterAll(async () => {
  await running?.close();
});

const app = () => {
  if (!running) throw new Error("no app");
  return running;
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app().url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const login = (email: unknown, password: unknown) => post("/admin/auth/login", { email, password });
const get = (path: string, token?: string) =>
  fetch(`${app().url}${path}`, { headers: token ? bearer(token) : {} });

/** A user made just for one test, so lockouts do not leak into other tests. */
async function newUser(options: { disabled?: boolean; tenantId?: string; role?: string } = {}) {
  const email = `u-${randomUUID().slice(0, 8)}@test.local`;
  const password = "a-long-test-password";
  const hash = await hashPassword(password);
  const row = await transaction(app().db, (tx) =>
    create(
      tx,
      { tenantId: options.tenantId ?? ALPHA, actor: "system/test", now: app().clock.now() },
      "admin_users",
      {
        email,
        name: "Test User",
        password_hash: hash,
        role: options.role ?? "tenant_admin",
        tenant_id: options.tenantId ?? ALPHA,
        disabled: options.disabled ?? false,
      },
    ),
  );
  return { id: row?.id as string, email, password };
}

/** An HS256 token made by hand, to try the checks one by one. */
function forge(
  secret: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "HS256" },
) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc(header)}.${enc(claims)}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
const adminClaims = (id: string, over: Record<string, unknown> = {}) => {
  const now = Math.floor(app().clock.now().getTime() / 1000);
  return {
    sub: id,
    role: "tenant_admin",
    tid: ALPHA,
    name: "x",
    iat: now,
    exp: now + 600,
    aud: "backoffice",
    ...over,
  };
};

describe("passwords (plain code)", () => {
  test("the same password with two salts gives two hashes; both verify", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("correct horse", b)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
    expect(await verifyPassword("correct horse", "scrypt$1$2")).toBe(false);
    expect(await verifyPassword("correct horse", "")).toBe(false);
  });
});

describe("permissions (plain code)", () => {
  const user = (role: AdminUser["role"], tenantId: string | null): AdminUser => ({
    id: "u",
    email: "e",
    name: "n",
    role,
    tenantId,
  });
  const actions: Action[] = ["read", "resolve", "propose_wheel", "decide_change"];
  // [action] -> viewer own, manager own, platform own, viewer other, manager other, platform other
  const table: Record<Action, boolean[]> = {
    read: [true, true, true, false, false, true],
    resolve: [false, true, true, false, false, true],
    propose_wheel: [false, true, true, false, false, true],
    decide_change: [false, false, true, false, false, true],
  };
  test("every cell of the role table", () => {
    for (const action of actions) {
      const got = [
        can(user("tenant_viewer", ALPHA), action, ALPHA),
        can(user("tenant_admin", ALPHA), action, ALPHA),
        can(user("platform_admin", null), action, ALPHA),
        can(user("tenant_viewer", ALPHA), action, BETA),
        can(user("tenant_admin", ALPHA), action, BETA),
        can(user("platform_admin", null), action, BETA),
      ];
      expect(got, action).toEqual(table[action]);
    }
  });
});

describe.skipIf(!running)("back office sign-in", () => {
  test("success: a token, the user, and no password anywhere", async () => {
    const r = await login(ALPHA_MANAGER, passwordOf(ALPHA_MANAGER));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { token: string; expiresAt: string; user: Record<string, unknown> };
    expect(body.user).toMatchObject({ email: ALPHA_MANAGER, role: "tenant_admin", tenantId: ALPHA });
    expect(JSON.stringify(body)).not.toContain("password");
    expect(Date.parse(body.expiresAt)).toBe(
      Math.floor(app().clock.now().getTime() / 1000) * 1000 + 30 * MINUTE,
    );
    const me = await get("/admin/auth/me", body.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual(body.user);
  });

  test("a wrong password, an unknown email and a disabled user all get the same 401", async () => {
    const disabled = await newUser({ disabled: true });
    const answers = await Promise.all([
      login(ALPHA_MANAGER, "wrong-password"),
      login("nobody@nowhere.test", "wrong-password"),
      login(disabled.email, disabled.password), // right password, still refused
      login(undefined, undefined),
    ]);
    const texts = await Promise.all(answers.map((a) => a.text()));
    expect(answers.map((a) => a.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(texts).size).toBe(1);
  });

  test("five failures in a row lock the user for 15 minutes; the clock unlocks; a success resets the count", async () => {
    const u = await newUser();
    for (let i = 0; i < 4; i++) expect((await login(u.email, "nope")).status).toBe(401);
    expect((await login(u.email, u.password)).status).toBe(200); // a success resets the count
    for (let i = 0; i < 4; i++) expect((await login(u.email, "nope")).status).toBe(401);
    expect((await login(u.email, u.password)).status).toBe(200); // four after the reset is not five

    for (let i = 0; i < 5; i++) expect((await login(u.email, "nope")).status).toBe(401);
    expect((await login(u.email, u.password)).status).toBe(401); // locked: even the right password
    app().clock.advance(14 * MINUTE);
    expect((await login(u.email, u.password)).status).toBe(401);
    app().clock.advance(1 * MINUTE + 1);
    expect((await login(u.email, u.password)).status).toBe(200);

    const reasons = (
      await app().db.query(
        "SELECT changes->>'reason' AS reason FROM audit_log WHERE action = 'admin_login_failed' AND entity_id = $1 ORDER BY id",
        [u.id],
      )
    ).rows.map((r) => r.reason);
    expect(reasons.filter((x) => x === "locked")).toHaveLength(2);
  });

  test("the token expires by the clock", async () => {
    const token = await loginAs(app(), ALPHA_MANAGER);
    expect((await get(`/admin/${ALPHA}/alerts`, token)).status).toBe(200);
    app().clock.advance(29 * MINUTE);
    expect((await get(`/admin/${ALPHA}/alerts`, token)).status).toBe(200);
    app().clock.advance(2 * MINUTE);
    expect((await get(`/admin/${ALPHA}/alerts`, token)).status).toBe(401);
  });

  test("a tampered token, alg none, a wrong audience, a lifetime that is too long: 401", async () => {
    const good = await loginAs(app(), ALPHA_MANAGER);
    const [h, p, s] = good.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const asOps = Buffer.from(JSON.stringify({ ...claims, role: "platform_admin", tid: null })).toString(
      "base64url",
    );
    const id = claims.sub as string;
    const bad: Record<string, string> = {
      "payload changed, signature kept": `${h}.${asOps}.${s}`,
      "signature cut": `${h}.${p}.${s.slice(0, -4)}`,
      "no signature": `${h}.${p}.`,
      "alg none": `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.`,
      "alg HS512": forge(TEST_ADMIN_TOKEN_SECRET, adminClaims(id), { alg: "HS512" }),
      "wrong audience": forge(TEST_ADMIN_TOKEN_SECRET, adminClaims(id, { aud: "player" })),
      "no audience": forge(TEST_ADMIN_TOKEN_SECRET, adminClaims(id, { aud: undefined })),
      "lifetime 31 minutes": forge(
        TEST_ADMIN_TOKEN_SECRET,
        adminClaims(id, { exp: Math.floor(app().clock.now().getTime() / 1000) + 31 * 60 }),
      ),
      "wrong secret": forge("another-secret-another-secret-another", adminClaims(id)),
      "not a token": "abc",
    };
    // The same claims signed right are accepted, so only the named flaw is what is refused.
    expect(
      (await get(`/admin/${ALPHA}/alerts`, forge(TEST_ADMIN_TOKEN_SECRET, adminClaims(id)))).status,
    ).toBe(200);
    for (const [name, token] of Object.entries(bad)) {
      expect((await get(`/admin/${ALPHA}/alerts`, token)).status, name).toBe(401);
    }
    expect((await get("/admin/auth/me")).status).toBe(401);
    const noBearer = await fetch(`${app().url}/admin/${ALPHA}/alerts`, { headers: { authorization: good } });
    expect(noBearer.status).toBe(401);
  });

  test("a player token is not an admin token, and an admin token is not a player token", async () => {
    const alpha = demoTenants[0];
    if (!alpha) throw new Error("no tenant");
    const nowMs = app().clock.now().getTime();
    const player = tokenFor(ALPHA, alpha.tokenSecret, "p-1", nowMs);
    expect((await get(`/admin/${ALPHA}/alerts`, player)).status).toBe(401);
    expect((await get("/admin/auth/me", player)).status).toBe(401);
    // An admin token, whatever it says, is not accepted as a player token.
    const admin = await loginAs(app(), ALPHA_MANAGER);
    expect((await get("/me", admin)).status).toBe(401);
    // A token signed with the tenant's player secret, with admin claims.
    const id = (await app().db.query("SELECT id FROM admin_users WHERE email = $1", [ALPHA_MANAGER])).rows[0]
      .id;
    const forged = forge(alpha.tokenSecret, adminClaims(id));
    expect((await get(`/admin/${ALPHA}/alerts`, forged)).status).toBe(401);
    // Our own signing function with the player secret gives the same result.
    const viaSigner = signAdminToken(alpha.tokenSecret, app().clock.now(), {
      id,
      role: "tenant_admin",
      tenantId: ALPHA,
      name: "x",
    });
    expect((await get(`/admin/${ALPHA}/alerts`, viaSigner.token)).status).toBe(401);
  });

  test("the role table over HTTP: read, resolve, other tenant, unknown tenant", async () => {
    const someRedemption = randomUUID();
    const resolveBody = { outcome: "issued", note: "checked with the casino" };
    const cases: [email: string, tenant: string, read: number, resolve: number][] = [
      [ALPHA_VIEWER, ALPHA, 200, 403],
      [ALPHA_VIEWER, BETA, 404, 404],
      [ALPHA_MANAGER, ALPHA, 200, 404], // allowed, and there is no such redemption
      [ALPHA_MANAGER, BETA, 404, 404],
      [BETA_MANAGER, BETA, 200, 404],
      [BETA_MANAGER, ALPHA, 404, 404],
      [OPS, ALPHA, 200, 404],
      [OPS, BETA, 200, 404],
      [OPS, "no-such-tenant", 404, 404],
    ];
    for (const [email, tenant, read, resolve] of cases) {
      const token = await loginAs(app(), email);
      expect((await get(`/admin/${tenant}/alerts`, token)).status, `${email} reads ${tenant}`).toBe(read);
      const r = await post(
        `/admin/${tenant}/redemptions/${someRedemption}/resolve`,
        resolveBody,
        bearer(token),
      );
      expect(r.status, `${email} resolves in ${tenant}`).toBe(resolve);
    }
  });

  test("a disabled user's token, still valid, stops working at once", async () => {
    const u = await newUser();
    const token = ((await (await login(u.email, u.password)).json()) as { token: string }).token;
    expect((await get(`/admin/${ALPHA}/alerts`, token)).status).toBe(200);
    await app().db.query("UPDATE admin_users SET disabled = true WHERE id = $1", [u.id]);
    expect((await get(`/admin/${ALPHA}/alerts`, token)).status).toBe(401);
    expect((await get("/admin/auth/me", token)).status).toBe(401);
  });

  test("the audit trail names the person on a manual resolution and holds no password or hash", async () => {
    // A redemption stuck in `submitting`, written directly: this test is about who is named.
    const manager = (await app().db.query("SELECT id FROM admin_users WHERE email = $1", [ALPHA_MANAGER]))
      .rows[0];
    const player = (
      await app().db.query("INSERT INTO players (tenant_id, external_id) VALUES ($1, $2) RETURNING id", [
        ALPHA,
        `p-${randomUUID()}`,
      ])
    ).rows[0];
    const item = (
      await app().db.query("SELECT id, reward FROM store_items WHERE tenant_id = $1 LIMIT 1", [ALPHA])
    ).rows[0];
    const red = await app().db.query(
      `INSERT INTO redemptions (tenant_id, player_id, idempotency_key, item_id, cost_coins, reward, status, created_at, updated_at)
       VALUES ($1, $2, 'k', $3, 100, $4, 'submitting', now(), now()) RETURNING id`,
      [ALPHA, player.id, item.id, item.reward],
    );
    const id = red.rows[0].id as string;
    const token = await loginAs(app(), ALPHA_MANAGER);
    const r = await post(
      `/admin/${ALPHA}/redemptions/${id}/resolve`,
      { outcome: "refused", note: "the casino said so" },
      bearer(token),
    );
    expect(r.status).toBe(200);
    const trail = (await (await get(`/admin/${ALPHA}/audit?entityId=${id}`, token)).json()) as {
      actor: string;
      action: string;
    }[];
    const manual = trail.find((a) => a.action === "manual_resolution");
    expect(manual?.actor).toBe(`admin/${manager.id}`);
    expect(trail.some((a) => a.action === "update" && a.actor === `admin/${manager.id}`)).toBe(true);

    // Login records: the person is named, the email is there, no secret is.
    const logins = (await (await get(`/admin/${ALPHA}/audit?entityId=${manager.id}`, token)).json()) as {
      actor: string;
      action: string;
      changes: unknown;
    }[];
    expect(logins.some((a) => a.action === "admin_login" && a.actor === `admin/${manager.id}`)).toBe(true);
    const all = (await app().db.query("SELECT actor, action, entity_id, changes FROM audit_log")).rows;
    const text = JSON.stringify(all);
    for (const u of demoAdmins) expect(text).not.toContain(u.password);
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain("wrong-password");
    const failed = all.filter((a) => a.action === "admin_login_failed");
    expect(failed.length).toBeGreaterThan(0);
    const unknown = failed.find(
      (a) =>
        (a.changes as { reason: string }).reason === "unknown_email" &&
        (a.changes as { email: string }).email.includes("@"),
    );
    expect(unknown?.actor).toBe("unknown");
    expect(unknown?.changes).toMatchObject({ email: expect.stringContaining("@") });
  });

  test("password_hash is masked in the audit trail; an unknown email is cut to 100 characters", async () => {
    const u = await newUser();
    const created = (
      await app().db.query(
        "SELECT changes FROM audit_log WHERE entity_type = 'admin_users' AND entity_id = $1 AND action = 'create'",
        [u.id],
      )
    ).rows[0].changes as { field: string; to: unknown }[];
    expect(created.find((c) => c.field === "password_hash")?.to).toBe("***");
    expect(created.find((c) => c.field === "email")?.to).toBe(u.email);

    const long = `${"a".repeat(150)}@x.test`;
    expect((await login(long, "x")).status).toBe(401);
    const row = (
      await app().db.query(
        "SELECT entity_id, changes FROM audit_log WHERE action = 'admin_login_failed' AND tenant_id IS NULL ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
    expect(row.entity_id).toBe(long.slice(0, 100));
    expect((row.changes as { email: string }).email).toBe(long.slice(0, 100));
  });

  test("the demo seed makes the four users, and running it twice changes nothing", async () => {
    const count = async () => ({
      users: Number(
        (await app().db.query("SELECT count(*) FROM admin_users WHERE email LIKE '%demo%'")).rows[0].count,
      ),
      audit: Number(
        (
          await app().db.query(
            "SELECT count(*) FROM audit_log WHERE entity_type = 'admin_users' AND actor = 'system/seed'",
          )
        ).rows[0].count,
      ),
    });
    const before = await count();
    expect(before.users).toBe(4);
    expect(before.audit).toBe(4);
    await seedDemo(app().db, app().clock, "http://127.0.0.1:1");
    expect(await count()).toEqual(before);
    const hashes = (await app().db.query("SELECT password_hash FROM admin_users WHERE email LIKE '%demo%'"))
      .rows;
    for (const h of hashes) expect(h.password_hash).toMatch(/^scrypt\$/);
  });
});

describe.skipIf(!running)("GET /app-config.json", () => {
  test("seed off: no demoAdmins field at all", async () => {
    const body = (await (await get("/app-config.json")).json()) as Record<string, unknown>;
    expect("demoAdmins" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  test("seed on: the four demo users with their passwords", async () => {
    const seeded = await startApp({ config: { seedDemo: true } });
    if (!seeded) throw new Error("no app");
    try {
      const body = (await (await fetch(`${seeded.url}/app-config.json`)).json()) as {
        demoAdmins: { email: string; password: string; role: string; tenantId: string | null }[];
      };
      expect(body.demoAdmins).toHaveLength(4);
      expect(body.demoAdmins.find((u) => u.email === OPS)).toEqual({
        email: OPS,
        password: passwordOf(OPS),
        role: "platform_admin",
        tenantId: null,
      });
      // The listed passwords really sign in.
      for (const u of body.demoAdmins) {
        const r = await fetch(`${seeded.url}/admin/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: u.email, password: u.password }),
        });
        expect(r.status, u.email).toBe(200);
      }
    } finally {
      await seeded.close();
    }
  });
});
