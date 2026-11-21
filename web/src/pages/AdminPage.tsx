import { type FormEvent, useCallback, useEffect, useState } from "react";
import { adminRequest, refreshSession, switchTenant } from "../actions.ts";
import { describeFailure } from "../api.ts";
import { RequestLog } from "../components/RequestLog.tsx";
import { coins } from "../format.ts";
import { playerStatus } from "../status.ts";
import { dispatch, useAppState } from "../store.ts";

type Load<T> =
  | { kind: "loading" }
  | { kind: "na" }
  | { kind: "error"; text: string }
  | { kind: "ok"; data: T };

/** Reads one admin endpoint. 404 means "not in this build". */
function useAdminGet<T>(tenantId: string, path: string | null, refreshMs: number | null) {
  const [load, setLoad] = useState<Load<T>>({ kind: "loading" });
  const reload = useCallback(async () => {
    if (!tenantId || path === null) return;
    const res = await adminRequest(tenantId, "GET", path);
    if (res.status === 404) setLoad({ kind: "na" });
    else if (res.status === 401 || res.status === 403)
      setLoad({ kind: "error", text: "The admin key was not accepted for this casino." });
    else if (!res.ok) setLoad({ kind: "error", text: describeFailure(res) });
    else setLoad({ kind: "ok", data: res.body as T });
  }, [tenantId, path]);
  useEffect(() => {
    setLoad({ kind: "loading" });
    reload();
    if (refreshMs === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [reload, refreshMs]);
  return { load, reload };
}

function Status<T>({ load, children }: { load: Load<T>; children: (data: T) => React.ReactNode }) {
  if (load.kind === "loading") return <p className="muted">Loading</p>;
  if (load.kind === "na") return <p className="muted">Not available in this build.</p>;
  if (load.kind === "error")
    return (
      <p className="problem" role="alert">
        {load.text}
      </p>
    );
  return <>{children(load.data)}</>;
}

interface AlertsData {
  at: string;
  policyVersion: number | string;
  alerts: {
    code: string;
    severity: "warning" | "critical";
    subject: string;
    value: number | string;
    limit: number | string;
    detail: string;
  }[];
}

function Alerts({ tenantId }: { tenantId: string }) {
  const { load, reload } = useAdminGet<AlertsData>(tenantId, "/alerts", 10_000);
  return (
    <section className="panel" aria-labelledby="alerts-h">
      <div className="panel-head">
        <h2 id="alerts-h">Alerts</h2>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Refresh
        </button>
      </div>
      <Status load={load}>
        {(d) =>
          d.alerts.length === 0 ? (
            <p className="empty">
              No alerts. Checked at {new Date(d.at).toLocaleTimeString("en-GB")}, policy version{" "}
              {String(d.policyVersion)}.
            </p>
          ) : (
            <ul className="rows">
              {d.alerts.map((a) => (
                <li key={`${a.code}-${a.subject}`} className={`alert sev-${a.severity}`}>
                  <p>
                    <strong className="sev">{a.severity === "critical" ? "Critical" : "Warning"}</strong>{" "}
                    <span className="mono">{a.code}</span>
                    {" for "}
                    <span className="mono">{a.subject}</span>
                  </p>
                  <p className="muted">
                    {a.detail} (value {String(a.value)}, limit {String(a.limit)})
                  </p>
                </li>
              ))}
            </ul>
          )
        }
      </Status>
    </section>
  );
}

interface StuckItem {
  id: string;
  status: string;
  settled: boolean;
  playerExternalId: string;
  costCoins: string;
  ageSec: number;
  platformRef: string | null;
  lastPlatformCall: unknown;
}

function Resolve({ tenantId, id, onDone }: { tenantId: string; id: string; onDone: () => void }) {
  const [outcome, setOutcome] = useState<"issued" | "refused" | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const valid = note.trim().length >= 5 && note.length <= 500;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!outcome || !valid) return;
    const res = await adminRequest(tenantId, "POST", `/redemptions/${id}/resolve`, {
      outcome,
      note: note.trim(),
    });
    if (res.status === 409) setMessage("Already final. Nothing was changed.");
    else if (!res.ok) setMessage(describeFailure(res));
    else {
      setMessage("");
      onDone();
    }
  };
  return (
    <form className="resolve" onSubmit={submit}>
      <div className="seg-buttons">
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={outcome === "issued"}
          onClick={() => setOutcome("issued")}
        >
          Resolve as issued
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={outcome === "refused"}
          onClick={() => setOutcome("refused")}
        >
          Resolve as refused
        </button>
      </div>
      {outcome ? (
        <>
          <label className="field">
            <span>Note (5 to 500 characters, required)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            Confirm: {outcome}
          </button>
        </>
      ) : null}
      {message ? (
        <p className="problem" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}

function Stuck({ tenantId }: { tenantId: string }) {
  const { load, reload } = useAdminGet<{ limitSec: number; items: StuckItem[] }>(
    tenantId,
    "/redemptions/stuck",
    null,
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="panel" aria-labelledby="stuck-h">
      <div className="panel-head">
        <h2 id="stuck-h">Stuck redemptions</h2>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Use this only when the casino cannot tell us the outcome. What to choose is an agreement with the
        casino.
      </p>
      <Status load={load}>
        {(d) =>
          d.items.length === 0 ? (
            <p className="empty">Nothing is stuck. The limit is {d.limitSec} seconds.</p>
          ) : (
            <ul className="rows">
              {d.items.map((i) => (
                <li key={i.id}>
                  <p>
                    <span className="mono">{i.id}</span> is <strong>{i.status}</strong> for {i.ageSec} s,{" "}
                    {coins(i.costCoins)} coins, player <span className="mono">{i.playerExternalId}</span>
                    {i.platformRef ? (
                      <>
                        , casino reference <span className="mono">{i.platformRef}</span>
                      </>
                    ) : null}
                  </p>
                  {open === i.id ? (
                    <Resolve
                      tenantId={tenantId}
                      id={i.id}
                      onDone={() => {
                        setOpen(null);
                        reload();
                        refreshSession();
                      }}
                    />
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => setOpen(i.id)}>
                      Resolve
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Status>
    </section>
  );
}

interface AuditRow {
  id: string | number;
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: unknown;
  requestId: string | null;
}

function changeText(changes: unknown): string[] {
  if (!Array.isArray(changes)) return changes == null ? [] : [JSON.stringify(changes)];
  return changes.map((c) => {
    const x = c as { field?: unknown; from?: unknown; to?: unknown };
    return typeof x.field === "string"
      ? `${x.field}: ${JSON.stringify(x.from)} -> ${JSON.stringify(x.to)}`
      : JSON.stringify(c);
  });
}

function Audit({ tenantId }: { tenantId: string }) {
  const state = useAppState();
  const [entityId, setEntityId] = useState("");
  const [asked, setAsked] = useState("");
  const { load } = useAdminGet<AuditRow[]>(
    tenantId,
    asked ? `/audit?entityId=${encodeURIComponent(asked)}` : null,
    null,
  );
  const picks: { label: string; id: string }[] = [];
  for (const p of state.players.filter((x) => x.tenantId === tenantId)) {
    const me = state.meByPlayer[p.key];
    if (me) picks.push({ label: `Player ${p.externalId}`, id: me.playerId });
    for (const s of me?.spins ?? [])
      picks.push({ label: `Spin ${s.id.slice(0, 8)} (${s.status})`, id: s.id });
  }
  for (const t of state.tracked.filter((x) => x.tenantId === tenantId))
    picks.push({ label: `Redemption ${t.id.slice(0, 8)} (${t.itemName})`, id: t.id });
  const ask = (id: string) => {
    setEntityId(id);
    setAsked(id.trim());
  };
  return (
    <section className="panel" aria-labelledby="audit-h">
      <h2 id="audit-h">Audit trail</h2>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(entityId);
        }}
      >
        <label className="field grow">
          <span>Entity id (spin, redemption or player)</span>
          <input value={entityId} onChange={(e) => setEntityId(e.target.value)} className="mono" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!entityId.trim()}>
          Show
        </button>
      </form>
      {picks.length > 0 ? (
        <div className="picks">
          {picks.map((p) => (
            <button key={p.id} type="button" className="btn btn-quiet" onClick={() => ask(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      {asked ? (
        <Status load={load}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="empty">No audit rows for this id.</p>
            ) : (
              <ol className="audit">
                {rows.map((r) => (
                  <li key={r.id}>
                    <p>
                      <span className="mono muted">{new Date(r.at).toLocaleTimeString("en-GB")}</span>{" "}
                      <strong>{r.action}</strong> {r.entityType} by <span className="mono">{r.actor}</span>
                    </p>
                    {changeText(r.changes).map((c) => (
                      <p key={c} className="mono change">
                        {c}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            )
          }
        </Status>
      ) : null}
    </section>
  );
}

function Session() {
  const state = useAppState();
  useEffect(() => {
    refreshSession();
  }, []);
  const players = state.players.filter((p) => p.tenantId === state.tenantId);
  return (
    <section className="panel" aria-labelledby="session-h">
      <div className="panel-head">
        <h2 id="session-h">Players in this session</h2>
        <button type="button" className="btn btn-secondary" onClick={() => refreshSession()}>
          Refresh
        </button>
      </div>
      {players.length === 0 ? (
        <p className="empty">No players yet. Open the player page to start one.</p>
      ) : (
        <ul className="rows">
          {players.map((p) => {
            const me = state.meByPlayer[p.key];
            const rs = state.tracked.filter((t) => t.playerKey === p.key);
            return (
              <li key={p.key}>
                <p>
                  <span className="mono">{p.externalId}</span>{" "}
                  {p.key === state.currentKey ? <span className="tag">on the player page</span> : null}
                </p>
                <p className="muted">
                  {me?.balance
                    ? `${coins(me.balance.available)} coins, ${coins(me.balance.reserved)} held`
                    : "balance unknown"}
                  ; {me ? me.spins.filter((s) => s.status === "available").length : 0} spins left
                </p>
                {rs.map((t) => (
                  <p key={t.id}>
                    {t.itemName}:{" "}
                    {t.data ? `${playerStatus(t.data.status).text} (${t.data.status})` : "not read yet"}{" "}
                    <span className="mono muted">{t.id.slice(0, 8)}</span>
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AdminPage() {
  const state = useAppState();
  const tenantId = state.tenantId;
  return (
    <main className="admin">
      <h1>Back office</h1>
      <section className="panel" aria-labelledby="who-h">
        <h2 id="who-h">Casino and key</h2>
        <div className="inline-form">
          <label className="field">
            <span>Casino</span>
            <select value={tenantId} onChange={(e) => switchTenant(e.target.value)}>
              {state.tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Admin key</span>
            <input
              className="mono"
              value={state.adminKeys[tenantId] ?? ""}
              onChange={(e) => dispatch({ type: "adminKey", tenantId, key: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Your name in the audit trail</span>
            <input
              value={state.adminName}
              onChange={(e) => dispatch({ type: "adminName", name: e.target.value })}
            />
          </label>
        </div>
        <p className="muted">
          The key is filled in for you because this is a demo. A real back office would ask for a sign-in.
        </p>
        <p>
          <a href={`${state.fakeCasinoUrl}/`} target="_blank" rel="noreferrer">
            Casino control panel (faults, many-player runs, verdict)
          </a>
        </p>
      </section>
      {tenantId ? (
        <>
          <Alerts tenantId={tenantId} />
          <Stuck tenantId={tenantId} />
          <Audit tenantId={tenantId} />
          <Session />
        </>
      ) : null}
      <RequestLog log={state.log} />
    </main>
  );
}
