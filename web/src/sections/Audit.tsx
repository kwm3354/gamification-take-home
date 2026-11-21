import { changeLines } from "../admin/audit-format.ts";
import { tenantPath } from "../admin/client.ts";
import { queryString, useAdmin, useFilters, useGet, usePaged } from "../admin/hooks.ts";
import { Actor, type Column, DataTable, Filters, Id, LoadMore, PageTitle, Time, tableStatus } from "../admin/ui.tsx";

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  /** Set when the actor is an admin user; null for a player, the system or a policy. */
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  changes: unknown;
  requestId: string | null;
  cursor?: string;
}

export const AUDIT_COLUMNS: Column<AuditRow>[] = [
  { header: "Time", render: (r) => <Time iso={r.at} /> },
  { header: "Actor", render: (r) => <Actor actor={r.actor} email={r.actorEmail} /> },
  { header: "Action", render: (r) => r.action },
  { header: "Entity", render: (r) => <span>{r.entityType} <Id id={r.entityId} /></span> },
  {
    header: "Changes",
    render: (r) => (
      <div>
        {changeLines(r.changes).map((l, i) => (
          <div key={`${i}-${l}`} className="mono">
            {l}
          </div>
        ))}
      </div>
    ),
  },
  { header: "Request id", render: (r) => <span className="mono">{r.requestId ?? "-"}</span> },
];

/** Recent rows with filters, or all rows of one entity when an entity id is given. */
export function Audit() {
  const { tenantId } = useAdmin();
  const [values, setValues] = useFilters();
  const entityId = values.entityId ?? "";
  const filters = (
    <Filters
      fields={[
        { name: "action", label: "Action (exact)" },
        { name: "actor", label: "Actor starts with" },
        { name: "entityId", label: "Entity id (full)" },
      ]}
      values={{ action: values.action ?? "", actor: values.actor ?? "", entityId }}
      onChange={setValues}
    />
  );
  return (
    <>
      <PageTitle title="Audit" />
      {filters}
      <div className="gap" />
      {entityId ? (
        <ByEntity key={entityId} tenantId={tenantId} entityId={entityId} />
      ) : (
        <Recent tenantId={tenantId} action={values.action ?? ""} actor={values.actor ?? ""} />
      )}
    </>
  );
}

function ByEntity({ tenantId, entityId }: { tenantId: string; entityId: string }) {
  const { load } = useGet<AuditRow[]>(tenantPath(tenantId, `/audit${queryString({ entityId })}`));
  return (
    <DataTable
      caption="Audit rows of one entity, oldest first"
      columns={AUDIT_COLUMNS}
      rows={load.kind === "ok" ? load.data : []}
      rowKey={(r) => String(r.id)}
      {...tableStatus(load)}
      empty="No audit rows for this id."
    />
  );
}

function Recent({ tenantId, action, actor }: { tenantId: string; action: string; actor: string }) {
  const path = tenantPath(tenantId, `/audit${queryString({ recent: "1", action, actor })}`);
  const { state, busy, error, loadMore } = usePaged<AuditRow & { cursor: string }>(path);
  return (
    <>
      <DataTable
        caption="Recent audit rows, newest first"
        columns={AUDIT_COLUMNS}
        rows={state.items}
        rowKey={(r) => r.cursor}
        status={error && !state.loaded ? "error" : state.loaded ? "ok" : "loading"}
        error={error}
        empty="No audit rows match."
      />
      <LoadMore canLoad={state.next !== null} busy={busy} onClick={loadMore} shown={state.items.length} />
    </>
  );
}
