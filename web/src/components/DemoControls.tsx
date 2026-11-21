import { useState } from "react";
import { createPlayerAndLoad, selectPlayer, switchTenant } from "../actions.ts";
import type { State } from "../state.ts";

/** Everything that is demo scaffolding: which casino, which player, links. Closed by default. */
export function DemoControls({ state }: { state: State }) {
  const [open, setOpen] = useState(false);
  const mine = state.players.filter((p) => p.tenantId === state.tenantId);
  return (
    <div className="demo">
      <button type="button" className="btn btn-quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        Demo controls
      </button>
      {open ? (
        <div className="demo-panel">
          <fieldset>
            <legend>Casino</legend>
            <div className="seg-buttons">
              {state.tenants.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="btn btn-secondary"
                  aria-pressed={t.id === state.tenantId}
                  onClick={() => switchTenant(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <p className="muted">
              Alpha's casino confirms a reward at once. Beta's casino confirms it a moment later.
            </p>
          </fieldset>
          <fieldset>
            <legend>Player</legend>
            <div className="seg-buttons">
              <button type="button" className="btn btn-secondary" onClick={() => createPlayerAndLoad()}>
                New player
              </button>
              {mine.length > 0 ? (
                <label className="field">
                  <span className="visually-hidden">Player in this session</span>
                  <select value={state.currentKey ?? ""} onChange={(e) => selectPlayer(e.target.value)}>
                    {mine.map((p, i) => (
                      <option key={p.key} value={p.key}>
                        Player {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </fieldset>
          <p className="demo-links">
            <a href="#/admin">Admin page</a>
            <a href={`${state.fakeCasinoUrl}/`} target="_blank" rel="noreferrer">
              Casino control panel
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
