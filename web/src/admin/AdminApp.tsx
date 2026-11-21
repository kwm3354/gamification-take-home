import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { Overview } from "../sections/Overview.tsx";
import { SignIn } from "./SignIn.tsx";
import type { AdminUser } from "./auth.ts";
import { adminCall, auth, useAuth, useCalls } from "./client.ts";
import { AdminCtx } from "./hooks.ts";
import { canSee, roleLabel } from "./roles.ts";
import { type AdminRoute, SECTIONS, type Section, buildAdminHash, parseAdminHash } from "./routes.ts";

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

const LABELS: Record<Section, string> = {
  overview: "Overview",
  alerts: "Alerts",
  redemptions: "Redemptions",
  stuck: "Stuck redemptions",
  players: "Players",
  events: "Events",
  spins: "Spins",
  settings: "Settings",
  changes: "Waiting changes",
  outbox: "Outbox",
  audit: "Audit",
};

const VIEWS: Partial<Record<Section, () => ReactNode>> = {
  overview: Overview,
};

interface TenantInfo {
  id: string;
  name: string;
  platform: string;
}

const TENANT_KEY = "backoffice-tenant";

function readTenant(): string | null {
  try {
    return window.sessionStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

function useTenants(): TenantInfo[] | null {
  const [tenants, setTenants] = useState<TenantInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    adminCall("GET", "/platform/tenants").then((res) => {
      if (live) setTenants(res.ok && Array.isArray(res.body) ? (res.body as TenantInfo[]) : []);
    });
    return () => {
      live = false;
    };
  }, []);
  return tenants;
}

export function AdminApp() {
  const state = useAuth();
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  if (state.kind === "signedOut") return <SignIn state={state} />;
  return <Shell user={state.session.user} route={parseAdminHash(hash)} />;
}

function Shell({ user, route }: { user: AdminUser; route: AdminRoute | null }) {
  const tenants = useTenants();
  const [picked, setPicked] = useState(readTenant);
  const isPlatform = user.role === "platform_admin";
  const tenantId = isPlatform ? (tenants?.find((t) => t.id === picked)?.id ?? tenants?.[0]?.id ?? "") : (user.tenantId ?? "");
  const tenantName = tenants?.find((t) => t.id === tenantId)?.name ?? tenantId;

  const pick = (id: string) => {
    setPicked(id);
    try {
      window.sessionStorage.setItem(TENANT_KEY, id);
    } catch {
      // The choice is then kept for this page load only.
    }
  };

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    document.title = "Back office";
  }, []);

  let content: ReactNode;
  if (!route) {
    content = (
      <>
        <h1>Page not found</h1>
        <p>
          <a href={buildAdminHash({ section: "overview" })}>Go to the overview</a>
        </p>
      </>
    );
  } else if (!canSee(user.role, route.section)) {
    content = (
      <>
        <h1>Not allowed for your role</h1>
        <p className="muted">{roleLabel(user.role)} cannot open this page.</p>
      </>
    );
  } else if (!tenantId) {
    content = <p className="muted">{tenants === null ? "Loading" : "No tenant is available for this account."}</p>;
  } else {
    const View = VIEWS[route.section];
    content = (
      <AdminCtx.Provider value={{ tenantId, user, route }}>
        {View ? <View key={`${tenantId}/${route.section}/${route.id ?? ""}`} /> : <p className="muted">Not built yet.</p>}
      </AdminCtx.Provider>
    );
  }

  return (
    <div className="shell bo">
      <header className="topbar">
        <strong className="brand-line">Back office</strong>
        <button
          type="button"
          className="btn menu-toggle"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          Menu
        </button>
        <div className="topbar-right">
          <label className="tenant">
            <span>Tenant</span>
            {isPlatform && tenants && tenants.length > 0 ? (
              <select value={tenantId} onChange={(e) => pick(e.target.value)}>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.id})
                  </option>
                ))}
              </select>
            ) : (
              <span className="fixed">{tenantName || "none"}</span>
            )}
          </label>
          <span className="who">
            {user.name}, {roleLabel(user.role)}
            {user.tenantId ? `, ${user.tenantId}` : ""}
          </span>
          <button type="button" className="btn" onClick={() => auth().signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <nav className={`side${menuOpen ? " open" : ""}`} aria-label="Sections">
        <ul>
          {SECTIONS.filter((s) => canSee(user.role, s)).map((s) => (
            <li key={s}>
              <a
                href={buildAdminHash({ section: s })}
                aria-current={route?.section === s ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                {LABELS[s]}
              </a>
            </li>
          ))}
        </ul>
        <p className="muted side-foot">
          <a href="#/play">Player page</a>
        </p>
      </nav>
      <main className="content">{content}</main>
      <Requests />
    </div>
  );
}

function Requests() {
  const calls = useCalls();
  return (
    <details className="requests">
      <summary>Requests ({calls.length})</summary>
      {calls.length === 0 ? (
        <p className="muted">No calls yet.</p>
      ) : (
        <div className="table-wrap short">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Path</th>
                <th className="num">Status</th>
                <th className="num">ms</th>
              </tr>
            </thead>
            <tbody>
              {calls.slice(0, 100).map((c) => (
                <tr key={c.id}>
                  <td className="mono">{new Date(c.at).toISOString().slice(11, 19)}</td>
                  <td className="mono">{c.method}</td>
                  <td className="mono">{c.path}</td>
                  <td className={`num mono ${c.status === null || c.status >= 400 ? "bad" : ""}`}>{c.status ?? "none"}</td>
                  <td className="num mono">{c.ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
