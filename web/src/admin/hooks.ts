import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { adminCall, describeAdminFailure } from "./client.ts";
import type { AdminUser } from "./auth.ts";
import { type Page, type Paged, appendPage, emptyPaged } from "./pagination.ts";
import type { AdminRoute } from "./routes.ts";

export interface AdminContext {
  tenantId: string;
  user: AdminUser;
  route: AdminRoute;
}

export const AdminCtx = createContext<AdminContext | null>(null);

export function useAdmin(): AdminContext {
  const ctx = useContext(AdminCtx);
  if (!ctx) throw new Error("useAdmin is used outside the back office");
  return ctx;
}

export type Load<T> = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ok"; data: T };

/** Reads one endpoint. Keeps the old data while it re-reads. `path` null means "do not read". */
export function useGet<T>(path: string | null, refreshMs: number | null = null) {
  const [load, setLoad] = useState<Load<T>>({ kind: "loading" });
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (path === null) return;
    const mine = ++generation.current;
    const res = await adminCall("GET", path);
    if (mine !== generation.current) return;
    if (!res.ok) {
      setLoad({ kind: "error", text: describeAdminFailure(res) });
      return;
    }
    setLoad({ kind: "ok", data: res.body as T });
    setUpdatedAt(Date.now());
  }, [path]);

  useEffect(() => {
    setLoad({ kind: "loading" });
    reload();
    if (refreshMs === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, refreshMs);
    return () => {
      window.clearInterval(timer);
      generation.current++;
    };
  }, [reload, refreshMs]);

  return { load, reload, updatedAt };
}

/** Reads a list page by page. `path` already holds the filters; "Load more" adds `before`. */
export function usePaged<T extends { cursor: string }>(path: string | null) {
  const [state, setState] = useState<Paged<T>>(emptyPaged());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (before: string | null, replace: boolean) => {
      if (path === null) return;
      const mine = ++generation.current;
      setBusy(true);
      const url = before === null ? path : `${path}${path.includes("?") ? "&" : "?"}before=${encodeURIComponent(before)}`;
      const res = await adminCall("GET", url);
      if (mine !== generation.current) return;
      setBusy(false);
      if (!res.ok) {
        setError(describeAdminFailure(res));
        return;
      }
      setError(null);
      const page = res.body as Page<T>;
      setState((old) => appendPage(replace ? emptyPaged<T>() : old, page));
    },
    [path],
  );

  useEffect(() => {
    setState(emptyPaged());
    setError(null);
    fetchPage(null, true);
    return () => {
      generation.current++;
    };
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (state.next !== null) fetchPage(state.next, false);
  }, [fetchPage, state.next]);

  return { state, busy, error, loadMore, reload: () => fetchPage(null, true) };
}

/** `?a=1&b=2` for the non-empty values, for an API path. */
export function queryString(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const text = p.toString();
  return text ? `?${text}` : "";
}
