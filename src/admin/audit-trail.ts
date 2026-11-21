import type { Db } from "../db.ts";
import { adminEmails } from "./actors.ts";
import { BadQuery, idCursor, pageOf, parseIdCursor } from "./paging.ts";

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  /** The email of the user when the actor is `admin/<user id>`; null for any other actor. */
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  changes: unknown;
  requestId: string | null;
}

/** The audit rows of one tenant for one entity, oldest first. */
export async function auditTrail(
  db: Pick<Db, "query">,
  tenantId: string,
  entityId: string,
): Promise<AuditEntry[]> {
  const { rows } = await db.query(
    `SELECT id, at, actor, action, entity_type, entity_id, changes, request_id
       FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
    [tenantId, entityId],
  );
  return withEmails(db, rows.map(entry));
}

async function withEmails<T extends Omit<AuditEntry, "actorEmail">>(
  db: Pick<Db, "query">,
  entries: T[],
): Promise<(T & { actorEmail: string | null })[]> {
  const emails = await adminEmails(
    db,
    entries.map((e) => e.actor),
  );
  return entries.map((e) => ({ ...e, actorEmail: emails.get(e.actor) ?? null }));
}

// biome-ignore lint/suspicious/noExplicitAny: a pg row
function entry(r: any): Omit<AuditEntry, "actorEmail"> {
  return {
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    changes: r.changes,
    requestId: r.request_id,
  };
}

/** The newest rows of the tenant's audit trail, optionally for one exact action and an actor prefix. */
export async function recentAudit(
  db: Pick<Db, "query">,
  tenantId: string,
  query: { actor?: unknown; action?: unknown; before?: unknown },
  limit: number,
) {
  for (const v of [query.actor, query.action]) {
    if (v !== undefined && (typeof v !== "string" || v.length > 200)) throw new BadQuery("bad filter");
  }
  const after = parseIdCursor(query.before);
  const params: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  if (query.action) where.push(`action = $${params.push(query.action)}`);
  if (query.actor) where.push(`starts_with(actor, $${params.push(query.actor)})`);
  if (after !== null) where.push(`id < $${params.push(after)}`);
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT id, at, actor, action, entity_type, entity_id, changes, request_id
       FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const entries = await withEmails(
    db,
    rows.map((r) => ({ ...entry(r), cursor: idCursor(r.id) })),
  );
  return pageOf(entries, limit);
}
