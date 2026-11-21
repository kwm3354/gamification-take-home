import type { Db } from "../db.ts";
import { BadQuery, idCursor, pageOf, parseIdCursor } from "./paging.ts";

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
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
  return rows.map(entry);
}

// biome-ignore lint/suspicious/noExplicitAny: a pg row
function entry(r: any): AuditEntry {
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
  return pageOf(
    rows.map((r) => ({ ...entry(r), cursor: idCursor(r.id) })),
    limit,
  );
}
