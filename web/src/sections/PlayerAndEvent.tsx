import { tenantPath } from "../admin/client.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import { buildAdminHash } from "../admin/routes.ts";
import { DataTable, Dl, Id, Json, Mark, Notice, PageTitle, Time, tableStatus } from "../admin/ui.tsx";
import { coins } from "../format.ts";
import {
  EVENT_COLUMNS,
  type EventRow,
  REDEMPTION_COLUMNS,
  type RedemptionRow,
  type SpinRow,
} from "./Lists.tsx";

interface PlayerDetailData {
  player: { id: string; externalId: string; createdAt: string };
  balance: { available: string; reserved: string } | null;
  spins: (Omit<SpinRow, "cursor" | "playerId" | "playerExternalId" | "segmentIndex"> & { grantPolicyVersion: number })[];
  redemptions: RedemptionRow[];
  events: EventRow[];
}

function Crumb({ section, label, id }: { section: "players" | "events"; label: string; id: string }) {
  return (
    <p className="crumb">
      <a href={buildAdminHash({ section })}>{label}</a> / <span className="mono">{id}</span>
    </p>
  );
}

const go = (section: "redemptions" | "events", id: string) => {
  window.location.hash = buildAdminHash({ section, id });
};

export function PlayerDetail() {
  const { tenantId, route } = useAdmin();
  const id = route.id ?? "";
  const { load } = useGet<PlayerDetailData>(tenantPath(tenantId, `/players/${encodeURIComponent(id)}`));
  const d = load.kind === "ok" ? load.data : null;
  return (
    <>
      <Crumb section="players" label="Players" id={id} />
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {d ? (
        <>
          <PageTitle title={`Player ${d.player.externalId}`} />
          <Dl
            items={[
              ["Id", <span className="mono" key="i">{d.player.id}</span>],
              ["External id", <span className="mono" key="e">{d.player.externalId}</span>],
              ["Created", <Time iso={d.player.createdAt} key="c" />],
              [
                "Coins available",
                d.balance ? coins(d.balance.available) : <span className="bad" key="a">ledger not answering</span>,
              ],
              ["Coins reserved", d.balance ? coins(d.balance.reserved) : <span className="bad" key="r">ledger not answering</span>],
            ]}
          />
          <h2>Spins (newest 50)</h2>
          <DataTable
            caption="Spins of this player"
            columns={[
              { header: "Created", render: (r) => <Time iso={r.createdAt} /> },
              { header: "Id", render: (r) => <Id id={r.id} /> },
              { header: "Status", render: (r) => <Mark status={r.status} /> },
              { header: "Coins", numeric: true, render: (r) => (r.coins === null ? "-" : coins(r.coins)) },
              { header: "Wheel", numeric: true, render: (r) => `v${r.wheelVersion}` },
              { header: "Grant policy", numeric: true, render: (r) => `v${r.grantPolicyVersion}` },
              { header: "Used", render: (r) => <Time iso={r.usedAt} /> },
              { header: "Credited", render: (r) => <Time iso={r.creditedAt} /> },
            ]}
            rows={d.spins}
            rowKey={(r) => r.id}
            status="ok"
            empty="No spins."
          />
          <h2>Redemptions (newest 50)</h2>
          <DataTable
            caption="Redemptions of this player"
            columns={REDEMPTION_COLUMNS}
            rows={d.redemptions}
            rowKey={(r) => r.id}
            status="ok"
            empty="No redemptions."
            onRow={(r) => go("redemptions", r.id)}
          />
          <h2>Events (newest 50)</h2>
          <DataTable
            caption="Events of this player"
            columns={EVENT_COLUMNS}
            rows={d.events}
            rowKey={(r) => r.id}
            status="ok"
            empty="No events."
            onRow={(r) => go("events", r.id)}
          />
        </>
      ) : null}
    </>
  );
}

interface EventDetailData extends EventRow {
  raw: unknown;
  spins: { id: string; status: string }[];
}

export function EventDetail() {
  const { tenantId, route } = useAdmin();
  const id = route.id ?? "";
  const { load } = useGet<EventDetailData>(tenantPath(tenantId, `/events/${encodeURIComponent(id)}`));
  const e = load.kind === "ok" ? load.data : null;
  return (
    <>
      <Crumb section="events" label="Events" id={id} />
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {e ? (
        <>
          <PageTitle title={`Event ${e.id.slice(0, 8)}`} />
          <Dl
            items={[
              ["Id", <span className="mono" key="i">{e.id}</span>],
              ["Platform event id", <span className="mono" key="p">{e.externalEventId}</span>],
              ["Kind", e.kind],
              ["Player", <a key="pl" href={buildAdminHash({ section: "players", id: e.playerId })}>{e.playerExternalId}</a>],
              ["Received", <Time iso={e.receivedAt} key="r" />],
            ]}
          />
          <h2>Spins this event gave</h2>
          <DataTable
            caption="Spins given by this event"
            columns={[
              { header: "Id", render: (s) => <Id id={s.id} /> },
              { header: "Status", render: (s) => <Mark status={s.status} /> },
            ]}
            rows={e.spins}
            rowKey={(s) => s.id}
            {...tableStatus(load)}
            empty="This event gave no spin."
          />
          <div className="columns">
            <section>
              <h2>Normalized</h2>
              <Json value={e.normalized} />
            </section>
            <section>
              <h2>Raw, as the platform sent it</h2>
              <Json value={e.raw} />
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
