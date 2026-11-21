import type { ReactNode } from "react";
import { tenantPath } from "../admin/client.ts";
import { queryString, useAdmin, useFilters, usePaged } from "../admin/hooks.ts";
import { type Section, buildAdminHash } from "../admin/routes.ts";
import { type Column, DataTable, Filters, LoadMore, PageTitle } from "../admin/ui.tsx";

interface Props<T> {
  title: string;
  /** The endpoint under `/admin/:tenantId/`, for example `redemptions`. */
  endpoint: string;
  filters: { name: string; label: string; options?: string[] }[];
  /** Parameters that are always sent and are not filters in the hash. */
  fixed?: Record<string, string>;
  columns: Column<T>[];
  empty: string;
  /** A row opens `#/admin/<detail>/<id>` when set. */
  detail?: Section;
  extraTools?: ReactNode;
}

/** A list read page by page ("Load more"), with filters kept in the hash. */
export function ListPage<T extends { id: string | number; cursor: string }>(p: Props<T>) {
  const { tenantId } = useAdmin();
  const [values, setValues] = useFilters();
  const known: Record<string, string> = {};
  for (const f of p.filters) if (values[f.name]) known[f.name] = values[f.name] ?? "";
  const path = tenantPath(tenantId, `/${p.endpoint}${queryString({ ...p.fixed, ...known })}`);
  const { state, busy, error, loadMore } = usePaged<T>(path);
  const status = error && !state.loaded ? "error" : state.loaded ? "ok" : "loading";
  const detail = p.detail;

  return (
    <>
      <PageTitle title={p.title}>{p.extraTools}</PageTitle>
      <Filters fields={p.filters} values={known} onChange={setValues} />
      <div className="gap" />
      <DataTable
        caption={p.title}
        columns={p.columns}
        rows={state.items}
        rowKey={(r) => r.cursor}
        status={status}
        error={error}
        empty={p.empty}
        {...(detail
          ? {
              onRow: (r: T) => {
                window.location.hash = buildAdminHash({ section: detail, id: String(r.id) });
              },
            }
          : {})}
      />
      {error && state.loaded ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      <LoadMore canLoad={state.next !== null} busy={busy} onClick={loadMore} shown={state.items.length} />
    </>
  );
}
