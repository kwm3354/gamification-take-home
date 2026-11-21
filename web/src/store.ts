import { useSyncExternalStore } from "react";
import { type Action, type Persisted, type State, initialState, persistedOf, reducer } from "./state.ts";

const STORAGE_KEY = "gamification-demo-session-v1";

function readStorage(): Persisted | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Persisted>;
    if (!Array.isArray(value.players) || !Array.isArray(value.redemptions)) return null;
    return {
      tenantId: typeof value.tenantId === "string" ? value.tenantId : "",
      players: value.players,
      currentKey: typeof value.currentKey === "string" ? value.currentKey : null,
      redemptions: value.redemptions,
    };
  } catch {
    return null;
  }
}

let lastWritten = "";

function writeStorage(state: State): void {
  const text = JSON.stringify(persistedOf(state));
  if (text === lastWritten) return;
  lastWritten = text;
  try {
    window.localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // The app works without storage.
  }
}

let started = false;
let state: State = initialState;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function dispatch(action: Action): void {
  const next = reducer(state, action);
  if (next === state) return;
  state = next;
  if (action.type !== "log" && action.type !== "hydrate") writeStorage(state);
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the saved session and starts listening to other tabs. Call once. */
export function startStore(): void {
  if (started) return;
  started = true;
  const saved = readStorage();
  if (saved) {
    lastWritten = JSON.stringify(saved);
    dispatch({ type: "hydrate", persisted: saved });
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = readStorage();
    if (!next) return;
    lastWritten = JSON.stringify(next);
    dispatch({ type: "hydrate", persisted: next });
  });
}

export function useAppState(): State {
  return useSyncExternalStore(subscribe, getState);
}
