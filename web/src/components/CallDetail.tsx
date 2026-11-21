import { useState } from "react";
import { toCurl } from "../curl.ts";
import type { LogEntry } from "../types.ts";

function pretty(text: string | null): string {
  if (!text) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The real request and response of one logged call. */
export function CallDetail({ entry }: { entry: LogEntry }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toCurl(entry));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="call">
      <p className="call-head">
        <span className="call-who">{entry.actor}</span>
        <span className="mono">
          {entry.method} {entry.url}
        </span>
      </p>
      <p className="call-meta">
        {entry.status === null
          ? `No answer${entry.error ? `: ${entry.error}` : ""}`
          : `Answer ${entry.status}`}
        , {entry.durationMs} ms
      </p>
      <div className="call-bodies">
        <div>
          <h4>Request</h4>
          <pre>{pretty(entry.requestBody)}</pre>
        </div>
        <div>
          <h4>Response</h4>
          <pre>{pretty(entry.responseBody)}</pre>
        </div>
      </div>
      <button type="button" className="btn btn-quiet" onClick={copy}>
        {copied ? "Copied" : "Copy as curl"}
      </button>
    </div>
  );
}
