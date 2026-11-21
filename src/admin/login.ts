import { record, update } from "../audit/audited.ts";
import type { Clock } from "../clock.ts";
import { type Db, transaction } from "../db.ts";
import type { Log } from "../logging/log.ts";
import { signAdminToken } from "./admin-token.ts";
import { dummyHash, verifyPassword } from "./password.ts";
import type { AdminUser, Role } from "./permissions.ts";

/** Plain sign-in logic: password check, lockout, audit. The controller only calls it. */
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;

export interface UserRow extends AdminUser {
  passwordHash: string;
  failedLogins: number;
  lockedUntil: Date | null;
  disabled: boolean;
}

function toUser(r: Record<string, unknown>): UserRow {
  return {
    id: r.id as string,
    email: r.email as string,
    name: r.name as string,
    role: r.role as Role,
    tenantId: (r.tenant_id as string | null) ?? null,
    passwordHash: r.password_hash as string,
    failedLogins: r.failed_logins as number,
    lockedUntil: (r.locked_until as Date | null) ?? null,
    disabled: r.disabled as boolean,
  };
}

export async function findUserByEmail(db: Pick<Db, "query">, email: string): Promise<UserRow | null> {
  const { rows } = await db.query("SELECT * FROM admin_users WHERE email = $1", [email]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserById(db: Pick<Db, "query">, id: string): Promise<UserRow | null> {
  const { rows } = await db.query("SELECT * FROM admin_users WHERE id = $1", [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export const publicUser = (u: AdminUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  tenantId: u.tenantId,
});

export type LoginResult =
  | { ok: true; token: string; expiresAt: string; user: ReturnType<typeof publicUser> }
  | { ok: false };

export async function login(
  deps: { db: Db; clock: Clock; secret: string; log?: Log },
  emailInput: unknown,
  password: unknown,
): Promise<LoginResult> {
  const email = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
  const given = typeof password === "string" ? password : "";
  const user = email === "" ? null : await findUserByEmail(deps.db, email);
  // The same work whether or not the email exists.
  const matches = await verifyPassword(given, user ? user.passwordHash : await dummyHash());
  const now = deps.clock.now();
  const typed = (typeof emailInput === "string" ? emailInput : "").slice(0, 100);

  const fail = async (
    reason: "bad_credentials" | "locked",
    why: string,
    counted: boolean,
  ): Promise<LoginResult> => {
    await transaction(deps.db, async (tx) => {
      const ctx = { tenantId: user?.tenantId ?? null, actor: "unknown", now };
      if (user && counted) {
        await update(tx, ctx, "admin_users", user.id, (cur) => {
          const failures = (cur.failed_logins as number) + 1;
          return failures >= MAX_FAILURES
            ? { failed_logins: 0, locked_until: new Date(now.getTime() + LOCK_MS) }
            : { failed_logins: failures };
        });
      }
      await record(tx, ctx, {
        action: "admin_login_failed",
        entityType: "admin_user",
        entityId: user ? user.id : typed,
        changes: { email: user ? user.email : typed, reason: why },
      });
    });
    deps.log?.event("warn", "admin.login_failed", { tenantId: user?.tenantId ?? null, reason });
    return { ok: false };
  };

  if (!user) return fail("bad_credentials", "unknown_email", false);
  if (user.disabled) return fail("bad_credentials", "disabled", false);
  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) return fail("locked", "locked", false);
  if (!matches) return fail("bad_credentials", "wrong_password", true);

  const { token, expiresAt } = signAdminToken(deps.secret, now, user);
  await transaction(deps.db, async (tx) => {
    const ctx = { tenantId: user.tenantId, actor: `admin/${user.id}`, now };
    await update(tx, ctx, "admin_users", user.id, () => ({ failed_logins: 0, locked_until: null }));
    await record(tx, ctx, {
      action: "admin_login",
      entityType: "admin_user",
      entityId: user.id,
      changes: { email: user.email },
    });
  });
  deps.log?.event("info", "admin.login", { tenantId: user.tenantId, userId: user.id, role: user.role });
  return { ok: true, token, expiresAt: expiresAt.toISOString(), user: publicUser(user) };
}
