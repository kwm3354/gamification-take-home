import { useState } from "react";
import type { LogEntry } from "../types.ts";
import { CallDetail } from "./CallDetail.tsx";

const time = (at: number): string => new Date(at).toLocaleTimeString("en-GB");

/** Every call the page made, newest first. */
export function RequestLog({ log }: { log: LogEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <details className="panel log">
      <summary>Request log ({log.length})</summary>
      {log.length === 0 ? <p className="muted">No calls yet.</p> : null}
      <ul className="log-list">
        {log.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="log-row"
              aria-expanded={open === e.id}
              onClick={() => setOpen(open === e.id ? null : e.id)}
            >
              <span className="mono muted">{time(e.at)}</span>
              <span className="log-who">{e.actor}</span>
              <span className="mono log-url">
                {e.method} {new URL(e.url, window.location.href).pathname}
              </span>
              <span className={`mono ${e.status === null || e.status >= 400 ? "bad" : "good"}`}>
                {e.status ?? "no answer"}
              </span>
              <span className="mono muted">{e.durationMs} ms</span>
            </button>
            {open === e.id ? <CallDetail entry={e} /> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
