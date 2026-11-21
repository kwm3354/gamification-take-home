import { useEffect, useSyncExternalStore } from "react";
import { boot, pollOnce } from "./actions.ts";
import { AdminApp } from "./admin/AdminApp.tsx";
import { isAdminHash } from "./admin/routes.ts";
import { PlayPage } from "./pages/PlayPage.tsx";
import { isFinal } from "./state.ts";
import { startStore, useAppState } from "./store.ts";

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

/** Two routes, chosen by the URL hash: `#/play` (also the default) and `#/admin/...`. */
export function useRoute(): "play" | "admin" {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return isAdminHash(hash) ? "admin" : "play";
}

/** The player page with its session store. The back office never mounts this, so it never reads that store. */
function Play() {
  const state = useAppState();
  const pending = state.tracked.some((t) => !isFinal(t));

  useEffect(() => {
    startStore();
    boot();
  }, []);

  // Re-read the server while any redemption is not final. Stops when all are final or the tab is hidden.
  useEffect(() => {
    if (!pending) return;
    const tick = () => {
      if (document.visibilityState === "visible") pollOnce();
    };
    const timer = window.setInterval(tick, 2000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [pending]);

  return <PlayPage />;
}

export function App() {
  const route = useRoute();

  useEffect(() => {
    document.documentElement.dataset.route = route;
    if (route === "play") document.title = "Casino with Wheel of Fortune";
  }, [route]);

  return route === "admin" ? <AdminApp /> : <Play />;
}
