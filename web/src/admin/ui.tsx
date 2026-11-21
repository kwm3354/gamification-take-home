import { type ReactNode, useState } from "react";
import { type Load } from "./hooks.ts";
import { type Section, buildAdminHash } from "./routes.ts";

/** Shared pieces of the back office tables and detail pages. */

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function Id({ id, to }: { id: string; to?: { section: Section; id: string } }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  const text = (
    <span className="mono" title={id}>
      {shortId(id)}
    </span>
  );
  return (
    <span className="id">
      {to ? <a href={buildAdminHash({ section: to.section, id: to.id })}>{text}</a> : text}
      <button type="button" className="copy" onClick={copy} aria-label={`Copy id ${id}`}>
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

type Tone = "good" | "bad" | "warn" | "neutral";

const TONES: Record<string, Tone> = {
  issued: "good",
  applied: "good",
  used: "good",
  credited: "good",
  done: "good",
  accepted: "good",
  refused: "bad",
  rejected: "bad",
  dead: "bad",
  critical: "bad",
  insufficient: "bad",
  created: "warn",
  reserved: "warn",
  submitting: "warn",
  proposed: "warn",
  waiting: "warn",
  due: "warn",
  warning: "warn",
  available: "neutral",
};

/** Status as text with a small mark; the colour is never the only signal. */
export function Mark({ status }: { status: string }) {
  return (
    <span className={`mark mark-${TONES[status] ?? "neutral"}`}>
      <span className="dot" aria-hidden="true" />
      {status}
    </span>
  );
}

/** UTC time as `2026-11-21 08:00:00`. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return iso.slice(0, 19).replace("T", " ");
}

export function Time({ iso }: { iso: string | null | undefined }) {
  return (
    <span className="mono nowrap" title={iso ?? ""}>
      {formatTime(iso)}
    </span>
  );
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  numeric?: boolean;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** loading / error / ok of the first read. */
  status: "loading" | "error" | "ok";
  error?: string | null;
  empty: string;
  onRow?: (row: T) => void;
  caption: string;
}

export function DataTable<T>({ columns, rows, rowKey, status, error, empty, onRow, caption }: TableProps<T>) {
  const span = columns.length;
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className={c.numeric ? "num" : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {status === "loading" ? (
            <tr>
              <td colSpan={span} className="state">
                Loading
              </td>
            </tr>
          ) : status === "error" ? (
            <tr>
              <td colSpan={span} className="state bad" role="alert">
                {error ?? "The list could not be read."}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={span} className="state">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRow ? "clickable" : undefined}
                onClick={
                  onRow
                    ? (e) => {
                        if (e.target instanceof Element && e.target.closest("a, button")) return;
                        onRow(row);
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.header} className={c.numeric ? "num" : undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The table state of a plain `useGet` result. */
export function tableStatus<T>(load: Load<T>): { status: "loading" | "error" | "ok"; error: string | null } {
  return load.kind === "error"
    ? { status: "error", error: load.text }
    : { status: load.kind === "loading" ? "loading" : "ok", error: null };
}

export function Dl({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children ? <div className="page-tools">{children}</div> : null}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "bad" | "good" | "neutral"; children: ReactNode }) {
  return (
    <p className={`notice-line notice-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function LoadMore({
  canLoad,
  busy,
  onClick,
  shown,
}: {
  canLoad: boolean;
  busy: boolean;
  onClick: () => void;
  shown: number;
}) {
  return (
    <div className="more">
      <span className="muted">{shown} shown</span>
      {canLoad ? (
        <button type="button" className="btn" disabled={busy} onClick={onClick}>
          {busy ? "Loading" : "Load more"}
        </button>
      ) : shown > 0 ? (
        <span className="muted">End of the list</span>
      ) : null}
    </div>
  );
}

/** Filter fields that write into the hash. Selects apply at once; text applies on Enter or when the field loses focus. */
export function Filters({
  fields,
  values,
  onChange,
}: {
  fields: { name: string; label: string; options?: string[] }[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [draft, setDraft] = useState(values);
  const key = JSON.stringify(values);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setDraft(values);
  }
  const apply = () => {
    if (fields.some((f) => (draft[f.name] ?? "") !== (values[f.name] ?? ""))) onChange(draft);
  };
  return (
    <form
      className="filters"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      {fields.map((f) => (
        <label key={f.name}>
          <span>{f.label}</span>
          {f.options ? (
            <select value={values[f.name] ?? ""} onChange={(e) => onChange({ ...values, [f.name]: e.target.value })}>
              <option value="">any</option>
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={draft[f.name] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
              onBlur={apply}
              spellCheck={false}
            />
          )}
        </label>
      ))}
    </form>
  );
}
