import { tenantPath } from "../admin/client.ts";
import { plain } from "../admin/audit-format.ts";
import { useAdmin, useGet } from "../admin/hooks.ts";
import { Mark, Notice, PageTitle, formatTime } from "../admin/ui.tsx";

interface AlertsData {
  at: string;
  policyVersion: number;
  alerts: { code: string; severity: string; subject: string; value: number | string; limit: number | string; detail: unknown }[];
}

export function Alerts() {
  const { tenantId } = useAdmin();
  const { load } = useGet<AlertsData>(tenantPath(tenantId, "/alerts"), 15_000);
  return (
    <>
      <PageTitle title="Alerts">
        {load.kind === "ok" ? (
          <span className="muted">
            at {formatTime(load.data.at)} UTC, ops policy version {load.data.policyVersion}
          </span>
        ) : null}
      </PageTitle>
      {load.kind === "loading" ? <p className="muted">Loading</p> : null}
      {load.kind === "error" ? <Notice tone="bad">{load.text}</Notice> : null}
      {load.kind === "ok" && load.data.alerts.length === 0 ? <Notice tone="good">No alerts. All checks are within their limits.</Notice> : null}
      {load.kind === "ok" && load.data.alerts.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Alerts</caption>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Code</th>
                <th>Subject</th>
                <th className="num">Value</th>
                <th className="num">Limit</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {load.data.alerts.map((a, i) => (
                <tr key={`${a.code}-${a.subject}-${i}`}>
                  <td>
                    <Mark status={a.severity} />
                  </td>
                  <td className="mono">{a.code}</td>
                  <td className="mono">{a.subject}</td>
                  <td className="num">{plain(a.value)}</td>
                  <td className="num">{plain(a.limit)}</td>
                  <td>
                    <details className="inline">
                      <summary>Show</summary>
                      <pre className="json">{JSON.stringify(a.detail, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
