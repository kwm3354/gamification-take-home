import { coins } from "../format.ts";
import { buildAdminHash } from "../admin/routes.ts";
import { Id, Mark, Time } from "../admin/ui.tsx";
import { ListPage } from "./ListPage.tsx";

export interface RedemptionRow {
  id: string;
  cursor: string;
  createdAt: string;
  updatedAt: string;
  playerId: string;
  playerExternalId: string;
  itemCode: string;
  itemName: string;
  costCoins: string;
  status: string;
  settled: boolean;
  platformRef: string | null;
  reason: string | null;
}

export interface SpinRow {
  id: string;
  cursor: string;
  playerId: string;
  playerExternalId: string;
  status: string;
  coins: string | null;
  segmentIndex: number | null;
  createdAt: string;
  usedAt: string | null;
  creditedAt: string | null;
  wheelVersion: number;
}

export interface EventRow {
  id: string;
  cursor: string;
  externalEventId: string;
  kind: string;
  /** Null for an event that matched no player, such as an ignored one. */
  playerId: string | null;
  playerExternalId: string | null;
  receivedAt: string;
  normalized: unknown;
}

export const PlayerLink = ({ id, external }: { id: string | null; external: string | null }) =>
  id === null || external === null ? <span className="muted">-</span> : <a href={buildAdminHash({ section: "players", id })}>{external}</a>;

export const REDEMPTION_COLUMNS = [
  { header: "Created", render: (r: RedemptionRow) => <Time iso={r.createdAt} /> },
  { header: "Id", render: (r: RedemptionRow) => <Id id={r.id} to={{ section: "redemptions", id: r.id }} /> },
  { header: "Player", render: (r: RedemptionRow) => <PlayerLink id={r.playerId} external={r.playerExternalId} /> },
  { header: "Item", render: (r: RedemptionRow) => r.itemName },
  { header: "Coins", numeric: true, render: (r: RedemptionRow) => coins(r.costCoins) },
  { header: "Status", render: (r: RedemptionRow) => <Mark status={r.status} /> },
  { header: "Settled", render: (r: RedemptionRow) => (r.settled ? "yes" : "no") },
  { header: "Platform ref", render: (r: RedemptionRow) => <span className="mono">{r.platformRef ?? "-"}</span> },
  { header: "Reason", render: (r: RedemptionRow) => r.reason ?? "-" },
];

export const SPIN_COLUMNS = [
  { header: "Created", render: (r: SpinRow) => <Time iso={r.createdAt} /> },
  { header: "Id", render: (r: SpinRow) => <Id id={r.id} /> },
  { header: "Player", render: (r: SpinRow) => <PlayerLink id={r.playerId} external={r.playerExternalId} /> },
  { header: "Status", render: (r: SpinRow) => <Mark status={r.status} /> },
  { header: "Coins", numeric: true, render: (r: SpinRow) => (r.coins === null ? "-" : coins(r.coins)) },
  { header: "Segment", numeric: true, render: (r: SpinRow) => r.segmentIndex ?? "-" },
  { header: "Wheel", numeric: true, render: (r: SpinRow) => `v${r.wheelVersion}` },
  { header: "Used", render: (r: SpinRow) => <Time iso={r.usedAt} /> },
  { header: "Credited", render: (r: SpinRow) => <Time iso={r.creditedAt} /> },
];

export const EVENT_COLUMNS = [
  { header: "Received", render: (r: EventRow) => <Time iso={r.receivedAt} /> },
  { header: "Id", render: (r: EventRow) => <Id id={r.id} to={{ section: "events", id: r.id }} /> },
  { header: "Platform event id", render: (r: EventRow) => <span className="mono">{r.externalEventId}</span> },
  { header: "Kind", render: (r: EventRow) => r.kind },
  { header: "Player", render: (r: EventRow) => <PlayerLink id={r.playerId} external={r.playerExternalId} /> },
];

export function Redemptions() {
  return (
    <ListPage<RedemptionRow>
      title="Redemptions"
      endpoint="redemptions"
      filters={[
        { name: "status", label: "Status", options: ["created", "reserved", "submitting", "issued", "refused", "insufficient"] },
        { name: "playerId", label: "Player id" },
      ]}
      columns={REDEMPTION_COLUMNS}
      empty="No redemptions match."
      detail="redemptions"
    />
  );
}

export function Spins() {
  return (
    <ListPage<SpinRow>
      title="Spins"
      endpoint="spins"
      filters={[
        { name: "status", label: "Status", options: ["available", "used"] },
        { name: "playerId", label: "Player id" },
      ]}
      columns={SPIN_COLUMNS}
      empty="No spins match."
    />
  );
}

export function Events() {
  return (
    <ListPage<EventRow>
      title="Events"
      endpoint="events"
      filters={[{ name: "kind", label: "Kind", options: ["deposit_succeeded", "ignored"] }]}
      columns={EVENT_COLUMNS}
      empty="No events match."
      detail="events"
    />
  );
}

export interface PlayerRow {
  id: string;
  cursor: string;
  externalId: string;
  createdAt: string;
  spinsAvailable: number;
  spinsUsed: number;
  redemptions: number;
}

export function Players() {
  return (
    <ListPage<PlayerRow>
      title="Players"
      endpoint="players"
      filters={[{ name: "q", label: "External id starts with" }]}
      columns={[
        { header: "External id", render: (r) => <span className="mono">{r.externalId}</span> },
        { header: "Id", render: (r) => <Id id={r.id} to={{ section: "players", id: r.id }} /> },
        { header: "Created", render: (r) => <Time iso={r.createdAt} /> },
        { header: "Spins available", numeric: true, render: (r) => r.spinsAvailable },
        { header: "Spins used", numeric: true, render: (r) => r.spinsUsed },
        { header: "Redemptions", numeric: true, render: (r) => r.redemptions },
      ]}
      empty="No players match."
      detail="players"
    />
  );
}

export interface OutboxRow {
  id: number;
  cursor: string;
  kind: string;
  refId: string;
  runAt: string;
  attempts: number;
  lastError: string | null;
  doneAt: string | null;
  deadAt: string | null;
}

function outboxState(r: OutboxRow): string {
  if (r.deadAt) return "dead";
  if (r.doneAt) return "done";
  return Date.parse(r.runAt) <= Date.now() ? "due" : "waiting";
}

export function Outbox() {
  return (
    <ListPage<OutboxRow>
      title="Outbox"
      endpoint="outbox"
      filters={[{ name: "state", label: "State", options: ["due", "waiting", "dead", "done"] }]}
      columns={[
        { header: "State", render: (r) => <Mark status={outboxState(r)} /> },
        { header: "Kind", render: (r) => r.kind },
        { header: "Ref", render: (r) => <Id id={r.refId} /> },
        { header: "Run at", render: (r) => <Time iso={r.runAt} /> },
        { header: "Attempts", numeric: true, render: (r) => r.attempts },
        { header: "Last error", render: (r) => r.lastError ?? "-" },
        { header: "Done", render: (r) => <Time iso={r.doneAt} /> },
        { header: "Dead", render: (r) => <Time iso={r.deadAt} /> },
      ]}
      empty="No jobs match."
    />
  );
}
