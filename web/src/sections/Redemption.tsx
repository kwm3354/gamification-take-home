import { type FormEvent, useState } from "react";
import { tenantPath, adminCall, describeAdminFailure } from "../admin/client.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import { can } from "../admin/roles.ts";
import { buildAdminHash } from "../admin/routes.ts";
import { DataTable, Dl, Json, Mark, Notice, PageTitle, Time } from "../admin/ui.tsx";
import { coins } from "../format.ts";
import { AUDIT_COLUMNS, type AuditRow } from "./Audit.tsx";
import { PlayerLink, type RedemptionRow } from "./Lists.tsx";

export interface Detail {
  redemption: RedemptionRow;
  reward: unknown;
  audit: AuditRow[];
  job: { runAt: string; attempts: number; lastError: string | null; doneAt: string | null; deadAt: string | null } | null;
}

export function RedemptionDetail() {
  const { tenantId, route, user } = useAdmin();
  const id = route.id ?? "";
  const { load, reload } = useGet<Detail>(tenantPath(tenantId, `/redemptions/${encodeURIComponent(id)}`));
  // Kept here, not in the form: the form disappears once the redemption is final.
  const [notice, setNotice] = useState<{ tone: "bad" | "good"; text: string } | null>(null);

  return (
    <>
      <p className="crumb">
        <a href={buildAdminHash({ section: "redemptions" })}>Redemptions</a> / <span className="mono">{id}</span>
      </p>
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {load.kind === "ok" ? (
        <>
          {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
          <Body
            d={load.data}
            canResolve={can(user.role, "resolve")}
            tenantId={tenantId}
            onChanged={reload}
            onMessage={setNotice}
          />
        </>
      ) : null}
    </>
  );
}

interface Message {
  tone: "bad" | "good";
  text: string;
}

function Body({
  d,
  canResolve,
  tenantId,
  onChanged,
  onMessage,
}: {
  d: Detail;
  canResolve: boolean;
  tenantId: string;
  onChanged: () => void;
  onMessage: (m: Message) => void;
}) {
  const r = d.redemption;
  return (
    <>
      <PageTitle title={`Redemption ${r.id.slice(0, 8)}`} />
      <Dl
        items={[
          ["Id", <span className="mono" key="id">{r.id}</span>],
          ["Status", <Mark status={r.status} key="s" />],
          ["Settled in the ledger", r.settled ? "yes" : "no"],
          ["Player", <PlayerLink id={r.playerId} external={r.playerExternalId} key="p" />],
          ["Item", `${r.itemName} (${r.itemCode})`],
          ["Coins", coins(r.costCoins)],
          ["Platform ref", <span className="mono" key="ref">{r.platformRef ?? "-"}</span>],
          ["Reason", r.reason ?? "-"],
          ["Created", <Time iso={r.createdAt} key="c" />],
          ["Updated", <Time iso={r.updatedAt} key="u" />],
        ]}
      />
      <h2>Reward</h2>
      <Json value={d.reward} />
      <h2>Job</h2>
      {d.job ? (
        <Dl
          items={[
            ["Attempts", d.job.attempts],
            ["Last error", d.job.lastError ?? "-"],
            ["Next run", <Time iso={d.job.runAt} key="n" />],
            ["Done", <Time iso={d.job.doneAt} key="d" />],
            ["Dead", <Time iso={d.job.deadAt} key="x" />],
          ]}
        />
      ) : (
        <p className="muted">No job row.</p>
      )}
      {r.status === "submitting" && canResolve ? <ResolveForm id={r.id} tenantId={tenantId} onChanged={onChanged} onMessage={onMessage} /> : null}
      <h2>Audit timeline</h2>
      <DataTable
        caption="Audit rows of this redemption, oldest first"
        columns={AUDIT_COLUMNS}
        rows={d.audit}
        rowKey={(a) => String(a.id)}
        status="ok"
        empty="No audit rows."
      />
    </>
  );
}

function ResolveForm({
  id,
  tenantId,
  onChanged,
  onMessage,
}: {
  id: string;
  tenantId: string;
  onChanged: () => void;
  onMessage: (m: Message) => void;
}) {
  const [outcome, setOutcome] = useState<"issued" | "refused">("issued");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = note.trim().length >= 5 && note.trim().length <= 500;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const res = await adminCall("POST", tenantPath(tenantId, `/redemptions/${encodeURIComponent(id)}/resolve`), {
      outcome,
      note: note.trim(),
    });
    setBusy(false);
    if (res.ok) {
      onMessage({ tone: "good", text: `Resolved as ${outcome}.` });
      onChanged();
    } else if (res.status === 409) {
      onMessage({ tone: "bad", text: "Already final. Someone else or the casino got there first." });
      onChanged();
    } else {
      setError(describeAdminFailure(res));
    }
  };

  return (
    <>
      <h2>Resolve by hand</h2>
      <form className="panel-form" onSubmit={submit}>
        <p className="muted">
          Use this only when the casino cannot tell us the outcome. What to choose is an agreement with the casino.
        </p>
        <fieldset className="radios">
          <legend className="visually-hidden">Outcome</legend>
          <label>
            <input type="radio" name="outcome" checked={outcome === "issued"} onChange={() => setOutcome("issued")} />
            <span>The casino issued the reward (issued)</span>
          </label>
          <label>
            <input type="radio" name="outcome" checked={outcome === "refused"} onChange={() => setOutcome("refused")} />
            <span>The casino did not issue it (refused)</span>
          </label>
        </fieldset>
        <label>
          <span>Note, 5 to 500 characters ({note.trim().length})</span>
          <textarea name="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} />
        </label>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div>
          <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
            {busy ? "Resolving" : "Resolve"}
          </button>
        </div>
      </form>
    </>
  );
}
