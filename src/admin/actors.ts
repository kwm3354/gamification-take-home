import type { Db } from "../db.ts";

const ADMIN = /^admin\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The email of each `admin/<user id>` actor in `actors`, in one query. Other actors (a player, the
 * system, a policy) and unknown users are left out, so the caller reads `null` for them.
 */
export async function adminEmails(
  db: Pick<Db, "query">,
  actors: Iterable<string | null>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const actor of actors) {
    const id = actor === null ? null : ADMIN.exec(actor)?.[1];
    if (actor && id) ids.set(actor, id);
  }
  if (ids.size === 0) return new Map();
  const { rows } = await db.query("SELECT id, email FROM admin_users WHERE id = ANY($1::uuid[])", [
    [...ids.values()],
  ]);
  const byId = new Map<string, string>(rows.map((r) => [r.id as string, r.email as string]));
  const out = new Map<string, string>();
  for (const [actor, id] of ids) {
    const email = byId.get(id);
    if (email) out.set(actor, email);
  }
  return out;
}
