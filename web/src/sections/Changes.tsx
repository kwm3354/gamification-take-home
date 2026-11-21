import { useState } from "react";
import { adminCall, describeAdminFailure } from "../admin/client.ts";
import { expectedPrize } from "../admin/expected-prize.ts";
import { useGet } from "../admin/hooks.ts";
import { Actor, Id, Notice, PageTitle, Time } from "../admin/ui.tsx";
import { SegmentsTable, type SettingsChange, segmentsOf } from "./Settings.tsx";

/** The list may be a bare array or wrapped; the contract does not say. */
function listOf(body: unknown): SettingsChange[] {
  if (Array.isArray(body)) return body as SettingsChange[];
  const wrapped = body as { items?: unknown; changes?: unknown } | null;
  const list = wrapped?.items ?? wrapped?.changes;
  return Array.isArray(list) ? (list as SettingsChange[]) : [];
}

export function Changes() {
  const { load, reload } = useGet<unknown>("/platform/settings-changes?status=proposed");
  const changes = load.kind === "ok" ? listOf(load.data) : [];
  return (
    <>
      <PageTitle title="Waiting changes">
        <span className="muted">Wheel changes of all tenants that are above their limit, oldest first</span>
      </PageTitle>
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {load.kind === "ok" && changes.length === 0 ? <Notice tone="good">Nothing is waiting.</Notice> : null}
      {changes.map((c) => (
        <ChangeCard key={c.id} change={c} onDone={reload} />
      ))}
    </>
  );
}

function ChangeCard({ change, onDone }: { change: SettingsChange; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "bad" | "good"; text: string } | null>(null);
  const segments = segmentsOf(change.proposed);
  const valid = note.trim().length >= 5 && note.trim().length <= 500;

  const decide = async (verb: "approve" | "reject") => {
    setBusy(true);
    const res = await adminCall("POST", `/platform/settings-changes/${encodeURIComponent(change.id)}/${verb}`, { note: note.trim() });
    setBusy(false);
    if (res.ok) {
      setMessage({ tone: "good", text: verb === "approve" ? "Approved and applied." : "Rejected." });
      onDone();
    } else if (res.status === 409) {
      setMessage({ tone: "bad", text: "This change is no longer waiting." });
      onDone();
    } else {
      setMessage({ tone: "bad", text: describeAdminFailure(res) });
    }
  };

  return (
    <section className="change">
      <h2>
        {change.tenantId ?? "tenant"} <span className="muted">proposed by </span>
        <Actor actor={change.proposedBy} email={change.proposedByEmail} /> <span className="muted">at </span>
        <Time iso={change.createdAt} />
      </h2>
      <p>
        Change <Id id={change.id} />. Expected prize{" "}
        <strong>{Number(change.expectedPrizeCoins ?? expectedPrize(segments))}</strong> coins against the limit of{" "}
        <strong>{Number(change.limitCoins)}</strong>.
      </p>
      <SegmentsTable segments={segments} />
      <div className="panel-form">
        <label>
          <span>Note, required, 5 to 500 characters ({note.trim().length})</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} />
        </label>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <div className="row-buttons">
          <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => decide("approve")}>
            Approve
          </button>
          <button type="button" className="btn" disabled={!valid || busy} onClick={() => decide("reject")}>
            Reject
          </button>
        </div>
      </div>
    </section>
  );
}
