import type { Db } from "../db.ts";

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
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    changes: r.changes,
    requestId: r.request_id,
  }));
}
