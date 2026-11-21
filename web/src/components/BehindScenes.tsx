import { useEffect, useMemo, useRef, useState } from "react";
import { rewardTitle } from "../format.ts";
import { buildTimeline } from "../narrate.ts";
import type { LogEntry, StoreItem } from "../types.ts";
import { CallDetail } from "./CallDetail.tsx";

interface Props {
  open: boolean;
  onClose: () => void;
  log: LogEntry[];
  items: StoreItem[];
}

/** A plain-language timeline of what happened, built from the real calls. Each line opens its call. */
export function BehindScenes({ open, onClose, log, items }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const end = useRef<HTMLLIElement>(null);
  const lines = useMemo(() => {
    const titles = Object.fromEntries(items.map((i) => [i.id, rewardTitle(i)]));
    return buildTimeline([...log].reverse(), titles);
  }, [log, items]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "nearest" });
  }, [open, lines.length]);

  return (
    <aside className={`scenes${open ? " is-open" : ""}`} aria-label="Behind the scenes" hidden={!open}>
      <header className="scenes-head">
        <h2>Behind the scenes</h2>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="muted scenes-intro">
        Each line is a real call. Press a line to see the request and the answer.
      </p>
      {lines.length === 0 ? <p className="muted">Nothing has happened yet. Make a deposit.</p> : null}
      <ol className="timeline">
        {lines.map((l) => (
          <li key={l.id} className={l.ok ? "is-ok" : "is-fail"}>
            <button
              type="button"
              className="tl-row"
              aria-expanded={expanded === l.id}
              onClick={() => setExpanded(expanded === l.id ? null : l.id)}
            >
              <span className="tl-mark" aria-hidden="true" />
              <span className="tl-text">
                <span className="visually-hidden">{l.ok ? "Done: " : "Problem: "}</span>
                {l.text}
              </span>
              <span className="tl-who">{l.actor}</span>
            </button>
            {expanded === l.id ? <CallDetail entry={l.entry} /> : null}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>
    </aside>
  );
}
