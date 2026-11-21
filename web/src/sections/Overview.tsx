import { tenantPath } from "../admin/client.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import { type Section, buildAdminHash } from "../admin/routes.ts";
import { PageTitle, Notice } from "../admin/ui.tsx";
import { coins } from "../format.ts";

export interface OverviewData {
  at: string;
  players: number;
  events24h: { accepted: number; ignored: number };
  spins: { available: number; used: number };
  redemptions: Record<"created" | "reserved" | "submitting" | "issued" | "refused" | "insufficient" | "unsettled", number>;
  coinsOutstanding: string | null;
  outbox: { due: number; waiting: number; dead: number };
  alerts: { critical: number; warning: number };
  settings: { wheelVersion: number; grantPolicyVersion: number; opsPolicyVersion: number };
}

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

function Count({ n, section, query }: { n: number; section: Section; query?: Record<string, string> }) {
  return (
    <a href={buildAdminHash({ section, ...(query ? { query } : {}) })} className="num-link">
      {coins(n)}
    </a>
  );
}

export function Overview() {
  const { tenantId } = useAdmin();
  const { load, updatedAt } = useGet<OverviewData>(tenantPath(tenantId, "/overview"), 10_000);

  return (
    <>
      <PageTitle title="Overview">
        {updatedAt ? <span className="muted">updated {clock(updatedAt)} UTC</span> : null}
      </PageTitle>
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {load.kind === "ok" ? <Numbers d={load.data} /> : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="num">{children}</dd>
    </div>
  );
}

function Numbers({ d }: { d: OverviewData }) {
  const r = d.redemptions;
  const status = (s: "created" | "reserved" | "submitting" | "issued" | "refused" | "insufficient") => (
    <Count n={r[s]} section="redemptions" query={{ status: s }} />
  );
  return (
    <div className="columns">
      <section>
        <h2>Players and game</h2>
        <dl className="grid narrow">
          <Row label="Players">
            <Count n={d.players} section="players" />
          </Row>
          <Row label="Events accepted, 24 h">
            <Count n={d.events24h.accepted} section="events" />
          </Row>
          <Row label="Events ignored, 24 h">
            <Count n={d.events24h.ignored} section="events" />
          </Row>
          <Row label="Spins available">
            <Count n={d.spins.available} section="spins" query={{ status: "available" }} />
          </Row>
          <Row label="Spins used">
            <Count n={d.spins.used} section="spins" query={{ status: "used" }} />
          </Row>
          <Row label="Coins outstanding">
            {d.coinsOutstanding === null ? <span className="bad">ledger not answering</span> : coins(d.coinsOutstanding)}
          </Row>
        </dl>
      </section>
      <section>
        <h2>Redemptions</h2>
        <dl className="grid narrow">
          <Row label="Created">{status("created")}</Row>
          <Row label="Reserved">{status("reserved")}</Row>
          <Row label="Submitting">{status("submitting")}</Row>
          <Row label="Issued">{status("issued")}</Row>
          <Row label="Refused">{status("refused")}</Row>
          <Row label="Insufficient">{status("insufficient")}</Row>
          <Row label="Not settled in the ledger">
            <Count n={r.unsettled} section="stuck" />
          </Row>
        </dl>
      </section>
      <section>
        <h2>Jobs, alerts, settings</h2>
        <dl className="grid narrow">
          <Row label="Outbox due">
            <Count n={d.outbox.due} section="outbox" query={{ state: "due" }} />
          </Row>
          <Row label="Outbox waiting">
            <Count n={d.outbox.waiting} section="outbox" query={{ state: "waiting" }} />
          </Row>
          <Row label="Outbox dead">
            <Count n={d.outbox.dead} section="outbox" query={{ state: "dead" }} />
          </Row>
          <Row label="Alerts, critical">
            <Count n={d.alerts.critical} section="alerts" />
          </Row>
          <Row label="Alerts, warning">
            <Count n={d.alerts.warning} section="alerts" />
          </Row>
          <Row label="Wheel version">
            <a href={buildAdminHash({ section: "settings" })} className="num-link">
              {d.settings.wheelVersion}
            </a>
          </Row>
          <Row label="Grant policy version">{d.settings.grantPolicyVersion}</Row>
          <Row label="Ops policy version">{d.settings.opsPolicyVersion}</Row>
        </dl>
      </section>
    </div>
  );
}
