import { useState } from "react";
import { adminCall, describeAdminFailure, tenantPath } from "../admin/client.ts";
import { plain } from "../admin/audit-format.ts";
import {
  type EditableSegment,
  expectedParts,
  expectedPrize,
  limitSentence,
  segmentProblems,
  sharePercent,
} from "../admin/expected-prize.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import { can } from "../admin/roles.ts";
import { Actor, DataTable, Id, Mark, Notice, PageTitle, Time } from "../admin/ui.tsx";
import { coins } from "../format.ts";

export interface Seg {
  label: string;
  coins: number;
  weight: number;
}

/** What `proposed` of a settings change holds: the segments, bare or inside `{ segments }`. */
export function segmentsOf(proposed: unknown): Seg[] {
  const list = Array.isArray(proposed) ? proposed : (proposed as { segments?: unknown } | null)?.segments;
  return Array.isArray(list) ? (list as Seg[]) : [];
}

export interface SettingsChange {
  id: string;
  tenantId?: string;
  status: string;
  proposed: unknown;
  expectedPrizeCoins: number | string | null;
  limitCoins: number | string | null;
  proposedBy: string;
  proposedByEmail: string | null;
  decidedBy: string | null;
  decidedByEmail: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface SettingsData {
  wheel: { id: string; version: number; createdAt: string; segments: Seg[]; expectedPrizeCoins: number }[];
  grantPolicies: { id: string; version: number; createdAt: string; params: unknown }[];
  opsPolicies: { id: string; version: number; createdAt: string; params: { maxExpectedPrizeCoins?: number } & Record<string, unknown> }[];
  storeItems: { id: string; code: string; name: string; costCoins: string; reward: unknown; active: boolean }[];
  changes: SettingsChange[];
}

export function SegmentsTable({ segments }: { segments: Seg[] }) {
  const { totalWeight } = expectedParts(segments);
  return (
    <div className="table-wrap segments">
      <table className="data">
        <thead>
          <tr>
            <th>Label</th>
            <th className="num">Coins</th>
            <th className="num">Weight</th>
            <th className="num">Share, %</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s, i) => (
            <tr key={`${s.label}-${i}`}>
              <td>{s.label}</td>
              <td className="num">{coins(s.coins)}</td>
              <td className="num">{coins(s.weight)}</td>
              <td className="num">{sharePercent(s.weight, totalWeight)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChangeTable({ changes }: { changes: SettingsChange[] }) {
  return (
    <DataTable
      caption="Settings changes"
      columns={[
        { header: "Proposed", render: (c) => <Time iso={c.createdAt} /> },
        { header: "Id", render: (c) => <Id id={c.id} /> },
        { header: "Status", render: (c) => <Mark status={c.status} /> },
        { header: "Expected prize", numeric: true, render: (c) => (c.expectedPrizeCoins === null ? "-" : plain(Number(c.expectedPrizeCoins))) },
        { header: "Limit", numeric: true, render: (c) => (c.limitCoins === null ? "-" : plain(Number(c.limitCoins))) },
        { header: "Proposed by", render: (c) => <Actor actor={c.proposedBy} email={c.proposedByEmail} /> },
        { header: "Decided by", render: (c) => <Actor actor={c.decidedBy} email={c.decidedByEmail} /> },
        { header: "Note", render: (c) => c.decisionNote ?? "-" },
        {
          header: "Segments",
          render: (c) => (
            <details className="inline">
              <summary>{segmentsOf(c.proposed).length} segments</summary>
              <SegmentsTable segments={segmentsOf(c.proposed)} />
            </details>
          ),
        },
      ]}
      rows={changes}
      rowKey={(c) => c.id}
      status="ok"
      empty="No changes yet."
    />
  );
}

export function Settings() {
  const { tenantId, user } = useAdmin();
  const { load, reload } = useGet<SettingsData>(tenantPath(tenantId, "/settings"));
  return (
    <>
      <PageTitle title="Settings" />
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {load.kind === "ok" ? <Body d={load.data} canPropose={can(user.role, "propose")} tenantId={tenantId} onChanged={reload} /> : null}
    </>
  );
}

function Body({ d, canPropose, tenantId, onChanged }: { d: SettingsData; canPropose: boolean; tenantId: string; onChanged: () => void }) {
  const current = d.wheel[0];
  const limit = Number(d.opsPolicies[0]?.params.maxExpectedPrizeCoins ?? Number.NaN);
  return (
    <>
      <h2>Wheel versions</h2>
      {d.wheel.map((w, i) => (
        <section key={w.id} className="version">
          <p>
            <strong>Version {w.version}</strong>
            {i === 0 ? " (current)" : ""}, created <Time iso={w.createdAt} />, expected prize{" "}
            <span className="num-link">{w.expectedPrizeCoins}</span> coins
          </p>
          <SegmentsTable segments={w.segments} />
        </section>
      ))}

      {canPropose && current ? (
        <ProposeWheel start={current.segments} limit={limit} tenantId={tenantId} onChanged={onChanged} />
      ) : null}
      <h2>Changes of this tenant</h2>
      <ChangeTable changes={d.changes} />

      <h2>Grant policy versions</h2>
      <DataTable
        caption="Grant policy versions"
        columns={[
          { header: "Version", numeric: true, render: (p) => p.version },
          { header: "Created", render: (p) => <Time iso={p.createdAt} /> },
          { header: "Parameters", render: (p) => <span className="mono">{plain(p.params)}</span> },
        ]}
        rows={d.grantPolicies}
        rowKey={(p) => p.id}
        status="ok"
        empty="No grant policy."
      />
      <h2>Ops policy versions</h2>
      <DataTable
        caption="Ops policy versions"
        columns={[
          { header: "Version", numeric: true, render: (p) => p.version },
          { header: "Created", render: (p) => <Time iso={p.createdAt} /> },
          { header: "Parameters", render: (p) => <span className="mono">{plain(p.params)}</span> },
        ]}
        rows={d.opsPolicies}
        rowKey={(p) => p.id}
        status="ok"
        empty="No ops policy. Changes of the wheel are refused until one exists."
      />
      <h2>Store items</h2>
      <DataTable
        caption="Store items"
        columns={[
          { header: "Code", render: (i) => <span className="mono">{i.code}</span> },
          { header: "Name", render: (i) => i.name },
          { header: "Cost, coins", numeric: true, render: (i) => coins(i.costCoins) },
          { header: "Reward", render: (i) => <span className="mono">{plain(i.reward)}</span> },
          { header: "Active", render: (i) => (i.active ? "yes" : "no") },
        ]}
        rows={d.storeItems}
        rowKey={(i) => i.id}
        status="ok"
        empty="No store items."
      />
    </>
  );
}

interface Row {
  label: string;
  coins: string;
  weight: string;
}

const num = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

function ProposeWheel({ start, limit, tenantId, onChanged }: { start: Seg[]; limit: number; tenantId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[]>(() =>
    start.map((s) => ({ label: s.label, coins: String(s.coins), weight: String(s.weight) })),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "good" | "bad" | "neutral"; text: string } | null>(null);

  const segments: EditableSegment[] = rows.map((r) => ({ label: r.label, coins: num(r.coins), weight: num(r.weight) }));
  const problems = segmentProblems(segments);
  const expected = problems.length === 0 ? expectedPrize(segments) : null;

  const edit = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    setBusy(true);
    setResult(null);
    const res = await adminCall("POST", tenantPath(tenantId, "/settings/wheel"), { segments });
    setBusy(false);
    const body = res.body as { wheelVersion?: number } | null;
    if (res.status === 201) {
      setResult({ tone: "good", text: `Applied at once as wheel version ${body?.wheelVersion ?? "?"}.` });
      onChanged();
    } else if (res.status === 202) {
      setResult({ tone: "neutral", text: "Saved. The change waits for the platform team to approve it." });
      onChanged();
    } else {
      setResult({ tone: "bad", text: describeAdminFailure(res) });
    }
  };

  return (
    <>
      <h2>Propose a new wheel</h2>
      <div className="panel-form wide">
        <div className="table-wrap">
          <table className="data edit-table">
            <thead>
              <tr>
                <th>Label</th>
                <th className="num">Coins</th>
                <th className="num">Weight</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                // The row index is the identity: rows have no other stable key while they are edited.
                <tr key={i}>
                  <td>
                    <input aria-label={`Label of row ${i + 1}`} value={r.label} onChange={(e) => edit(i, { label: e.target.value })} />
                  </td>
                  <td className="num">
                    <input className="n" inputMode="numeric" aria-label={`Coins of row ${i + 1}`} value={r.coins} onChange={(e) => edit(i, { coins: e.target.value })} />
                  </td>
                  <td className="num">
                    <input className="n" inputMode="numeric" aria-label={`Weight of row ${i + 1}`} value={r.weight} onChange={(e) => edit(i, { weight: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" className="btn" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button type="button" className="btn" onClick={() => setRows([...rows, { label: "", coins: "", weight: "" }])}>
            Add row
          </button>
        </div>
        {problems.length > 0 ? (
          <ul className="problems">
            {problems.slice(0, 5).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 5 ? <li>{problems.length - 5} more.</li> : null}
          </ul>
        ) : (
          <p className="limit-line">
            Expected prize: <strong className="num-link">{expected}</strong> coins per spin. Limit of the newest ops policy:{" "}
            <strong className="num-link">{Number.isNaN(limit) ? "none" : limit}</strong>.{" "}
            {Number.isNaN(limit) ? "The server refuses changes while the tenant has no ops policy." : limitSentence(segments, limit)}
          </p>
        )}
        {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
        <div>
          <button type="button" className="btn btn-primary" disabled={busy || problems.length > 0} onClick={submit}>
            {busy ? "Sending" : "Submit"}
          </button>
        </div>
      </div>
    </>
  );
}
