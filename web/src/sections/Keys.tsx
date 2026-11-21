import { useEffect, useState } from "react";
import { adminCall, describeAdminFailure, tenantPath } from "../admin/client.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import {
  KEEP_CHOICES,
  KEY_NAMES,
  type KeepId,
  type KeyItem,
  type KeyKind,
  type RotateAnswer,
  consequence,
  fakeCasinoSecretsBody,
  fakeCasinoSecretsUrl,
  secondsOf,
} from "../admin/keys.ts";
import { can } from "../admin/roles.ts";
import { DataTable, Notice, Time } from "../admin/ui.tsx";

/** The casino address from `/app-config.json`, or null when the page does not give one. */
async function loadFakeCasinoUrl(): Promise<string | null> {
  try {
    const res = await window.fetch("/app-config.json");
    const body = (await res.json()) as { fakeCasinoUrl?: unknown };
    return typeof body.fakeCasinoUrl === "string" && body.fakeCasinoUrl !== "" ? body.fakeCasinoUrl : null;
  } catch {
    return null;
  }
}

/** The "Keys" block of Settings: what the tenant's secrets look like, and how to replace them. */
export function Keys() {
  const { tenantId, user } = useAdmin();
  const { load, reload } = useGet<KeyItem[]>(tenantPath(tenantId, "/keys"));
  const canManage = can(user.role, "manage_keys");
  const [shown, setShown] = useState<RotateAnswer | null>(null);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const revokePrevious = async (kind: KeyKind) => {
    setMessage(null);
    const res = await adminCall("POST", tenantPath(tenantId, `/keys/${kind}/revoke-previous`));
    if (res.ok) {
      setMessage({ tone: "good", text: `The old ${KEY_NAMES[kind].toLowerCase()} no longer works.` });
      reload();
    } else {
      setMessage({ tone: "bad", text: describeAdminFailure(res) });
    }
  };

  return (
    <>
      <h2>Keys</h2>
      <p className="muted">
        The casino signs its events and its player tokens with these keys. We only show the first and last
        characters.
      </p>
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {load.kind === "ok" ? (
        <DataTable
          caption="Keys"
          columns={[
            { header: "Key", render: (k) => KEY_NAMES[k.kind] },
            { header: "Hint", render: (k) => <span className="mono">{k.hint}</span> },
            { header: "Replaced at", render: (k) => (k.rotatedAt ? <Time iso={k.rotatedAt} /> : "never") },
            {
              header: "Previous key",
              render: (k) =>
                k.previous ? (
                  <>
                    <span className="mono">{k.previous.hint}</span>, valid until <Time iso={k.previous.validUntil} />
                  </>
                ) : (
                  "none"
                ),
            },
            ...(canManage
              ? [
                  {
                    header: "Actions",
                    render: (k: KeyItem) => (
                      <KeyActions
                        item={k}
                        tenantId={tenantId}
                        onReplaced={(a) => {
                          setShown(a);
                          setMessage(null);
                          reload();
                        }}
                        onRevoke={() => revokePrevious(k.kind)}
                      />
                    ),
                  },
                ]
              : []),
          ]}
          rows={load.data}
          rowKey={(k) => k.kind}
          status="ok"
          empty="No keys."
        />
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {shown ? <NewSecret answer={shown} tenantId={tenantId} onClose={() => setShown(null)} /> : null}
    </>
  );
}

function KeyActions({
  item,
  tenantId,
  onReplaced,
  onRevoke,
}: {
  item: KeyItem;
  tenantId: string;
  onReplaced: (a: RotateAnswer) => void;
  onRevoke: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<KeepId>("now");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = KEY_NAMES[item.kind];

  const replace = async () => {
    setBusy(true);
    setError(null);
    const res = await adminCall("POST", tenantPath(tenantId, `/keys/${item.kind}/rotate`), {
      previousValidForSec: secondsOf(keep),
    });
    setBusy(false);
    if (res.status === 201) {
      setOpen(false);
      setConfirming(false);
      onReplaced(res.body as RotateAnswer);
    } else {
      setError(describeAdminFailure(res));
    }
  };

  return (
    <div className="panel-form">
      {!open ? (
        <div>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Replace
          </button>{" "}
          {item.previous ? (
            <button type="button" className="btn" onClick={onRevoke}>
              Stop the old key now
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <fieldset className="radios">
            <legend>What happens to the old {name.toLowerCase()}</legend>
            {KEEP_CHOICES.map((c) => (
              <label key={c.id}>
                <input
                  type="radio"
                  name={`keep-${item.kind}`}
                  checked={keep === c.id}
                  onChange={() => {
                    setKeep(c.id);
                    setConfirming(false);
                  }}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </fieldset>
          {confirming ? <Notice tone="neutral">{consequence(item.kind, keep)}</Notice> : null}
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div>
            {confirming ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={replace}>
                {busy ? "Replacing" : "Confirm: replace the key"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>
                Replace the key
              </button>
            )}{" "}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setOpen(false);
                setConfirming(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The new secret, once. The page does not keep it after Close. */
function NewSecret({ answer, tenantId, onClose }: { answer: RotateAnswer; tenantId: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [demo, setDemo] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [casinoUrl, setCasinoUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadFakeCasinoUrl().then((u) => {
      if (live) setCasinoUrl(u);
    });
    return () => {
      live = false;
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answer.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const giveToDemo = async () => {
    if (!casinoUrl) return;
    try {
      const res = await window.fetch(fakeCasinoSecretsUrl(casinoUrl, tenantId), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fakeCasinoSecretsBody(answer.kind, answer.secret)),
      });
      setDemo(
        res.status === 204
          ? { tone: "good", text: "The demo casino now signs with the new key." }
          : { tone: "bad", text: `The demo casino answered ${res.status}.` },
      );
    } catch {
      setDemo({ tone: "bad", text: "The demo casino did not answer." });
    }
  };

  return (
    <section className="panel-form" aria-label="New key">
      <p>
        <strong>New {KEY_NAMES[answer.kind].toLowerCase()}</strong>
      </p>
      <p>
        <code className="mono" data-testid="new-secret">
          {answer.secret}
        </code>
      </p>
      <p>This is the only time the key is shown. Put it into the casino&apos;s configuration now.</p>
      <div>
        <button type="button" className="btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>{" "}
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {casinoUrl ? (
        <div>
          <button type="button" className="btn" onClick={giveToDemo}>
            Give this key to the demo casino
          </button>
          <p className="muted">In real life the casino&apos;s engineer does this by hand, in the casino&apos;s own configuration.</p>
          {demo ? <Notice tone={demo.tone}>{demo.text}</Notice> : null}
        </div>
      ) : null}
    </section>
  );
}
