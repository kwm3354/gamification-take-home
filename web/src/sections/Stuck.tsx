import { plain } from "../admin/audit-format.ts";
import { tenantPath } from "../admin/client.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import { buildAdminHash } from "../admin/routes.ts";
import { DataTable, Id, Mark, PageTitle, formatDuration, tableStatus } from "../admin/ui.tsx";
import { coins } from "../format.ts";

interface StuckRow {
  id: string;
  status: string;
  settled: boolean;
  playerExternalId: string;
  costCoins: string;
  ageSec: number;
  platformRef: string | null;
  lastPlatformCall: unknown;
}

export interface StuckData {
  limitSec: number;
  items: StuckRow[];
}

/** One line, cut at 80 characters; the full text is the tooltip. */
function Short({ text }: { text: string }) {
  return (
    <span className="mono" title={text}>
      {text.length > 80 ? `${text.slice(0, 80)}...` : text}
    </span>
  );
}

export function Stuck() {
  const { tenantId } = useAdmin();
  const { load } = useGet<StuckData>(tenantPath(tenantId, "/redemptions/stuck"), 15_000);
  const rows = load.kind === "ok" ? load.data.items : [];
  return (
    <>
      <PageTitle title="Stuck redemptions">
        {load.kind === "ok" ? <span className="muted">older than {formatDuration(load.data.limitSec)} and not finished</span> : null}
      </PageTitle>
      <DataTable
        caption="Stuck redemptions"
        columns={[
          { header: "Id", render: (r) => <Id id={r.id} to={{ section: "redemptions", id: r.id }} /> },
          { header: "Status", render: (r) => <Mark status={r.status} /> },
          { header: "Settled", render: (r) => (r.settled ? "yes" : "no") },
          { header: "Player", render: (r) => <span className="mono">{r.playerExternalId}</span> },
          { header: "Coins", numeric: true, render: (r) => coins(r.costCoins) },
          { header: "Age", numeric: true, render: (r) => formatDuration(r.ageSec) },
          { header: "Platform ref", render: (r) => <span className="mono">{r.platformRef ?? "-"}</span> },
          { header: "Last platform call", render: (r) => <Short text={r.lastPlatformCall ? plain(r.lastPlatformCall) : "none"} /> },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        {...tableStatus(load)}
        empty="Nothing is stuck."
        onRow={(r) => {
          window.location.hash = buildAdminHash({ section: "redemptions", id: r.id });
        }}
      />
    </>
  );
}
