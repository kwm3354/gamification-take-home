// The bodies in this folder were captured from the real server (docs/samples.md says how); only the
// sign-in token is replaced. The assignments below are type checks: if the server's shape moves away
// from what the screen reads, `npm run web:typecheck` fails here. The expectations check the logic
// that reads those shapes.
import { describe, expect, it } from "vitest";
import { changeLines } from "../admin/audit-format.ts";
import { expectedPrize } from "../admin/expected-prize.ts";
import { type Page, appendPage, emptyPaged } from "../admin/pagination.ts";
import type { AdminUser } from "../admin/auth.ts";
import type { AuditRow } from "../sections/Audit.tsx";
import type { AlertsData } from "../sections/Alerts.tsx";
import type { Detail } from "../sections/Redemption.tsx";
import type { EventRow, OutboxRow, PlayerRow, RedemptionRow, SpinRow } from "../sections/Lists.tsx";
import type { OverviewData } from "../sections/Overview.tsx";
import type { EventDetailData, PlayerDetailData } from "../sections/PlayerAndEvent.tsx";
import { type SettingsChange, type SettingsData, segmentsOf } from "../sections/Settings.tsx";
import type { StuckData } from "../sections/Stuck.tsx";
import alphaAlerts from "./alpha-alerts.json";
import alphaAuditRecent from "./alpha-audit-recent.json";
import alphaEventsIgnored from "./alpha-events-ignored.json";
import alphaSettings from "./alpha-settings.json";
import auditEntity from "./audit-entity.json";
import betaEventsPage from "./beta-events-page.json";
import betaOutbox from "./beta-outbox-page.json";
import betaOverview from "./beta-overview.json";
import betaPlayers from "./beta-players-page.json";
import betaRedemptions from "./beta-redemptions-page.json";
import betaSpins from "./beta-spins-page.json";
import betaStuck from "./beta-stuck.json";
import eventDetail from "./event-detail.json";
import eventDetailIgnored from "./event-detail-ignored.json";
import login from "./login.json";
import platformChanges from "./platform-changes.json";
import playerDetail from "./player-detail.json";
import redemptionDetail from "./redemption-detail-resolved.json";
import tenantsOps from "./tenants-platform-admin.json";
import tenantsTenant from "./tenants-tenant-admin.json";
import wheelApplied from "./wheel-applied-201.json";
import wheelWaiting from "./wheel-waiting-202.json";

// The answer to a proposal has no emails; the screen reloads the list instead.
type AnswerChange = Omit<SettingsChange, "proposedByEmail" | "decidedByEmail">;

describe("the screen reads the shapes the real server sends", () => {
  it("sign-in answer and tenants", () => {
    const user: AdminUser = login.user as AdminUser;
    expect(user.role).toBe("platform_admin");
    expect(user.tenantId).toBeNull();
    expect(tenantsOps.map((t) => t.id)).toEqual(["alpha-casino", "beta-casino"]);
    expect(tenantsTenant).toHaveLength(1);
  });

  it("overview, alerts, stuck", () => {
    const overview: OverviewData = betaOverview;
    expect(typeof overview.coinsOutstanding === "string" || overview.coinsOutstanding === null).toBe(true);
    const alerts: AlertsData = alphaAlerts;
    expect(Array.isArray(alerts.alerts)).toBe(true);
    const stuck: StuckData = betaStuck;
    expect(Array.isArray(stuck.items)).toBe(true);
  });

  it("lists are { items, nextCursor } and every row has a cursor", () => {
    const events: Page<EventRow> = betaEventsPage;
    const redemptions: Page<RedemptionRow> = betaRedemptions;
    const spins: Page<SpinRow> = betaSpins;
    const outbox: Page<OutboxRow> = betaOutbox;
    const players: Page<PlayerRow> = betaPlayers;
    for (const page of [events, redemptions, spins, outbox, players]) {
      expect(typeof page.nextCursor).toBe("string");
      for (const row of page.items) expect(typeof (row as { cursor: string }).cursor).toBe("string");
    }
    // The outbox id is a number, so a page is keyed by the cursor, not by the id.
    expect(typeof outbox.items[0]?.id).toBe("number");
    const merged = appendPage(appendPage(emptyPaged<EventRow>(), events), events);
    expect(merged.items).toHaveLength(events.items.length);
  });

  it("an ignored event has no player", () => {
    const page: Page<EventRow> = alphaEventsIgnored;
    expect(page.items[0]?.kind).toBe("ignored");
    expect(page.items[0]?.playerId).toBeNull();
    const detail: EventDetailData = eventDetailIgnored;
    expect(detail.playerExternalId).toBeNull();
    const normal: EventDetailData = eventDetail;
    expect(normal.kind).toBe("deposit_succeeded");
  });

  it("details", () => {
    const red: Detail = redemptionDetail;
    expect(red.redemption.platformRef).toBe("manual");
    expect(red.job === null || typeof red.job.attempts === "number").toBe(true);
    const player: PlayerDetailData = playerDetail;
    expect(player.balance === null || typeof player.balance.available === "string").toBe(true);
  });

  it("audit rows: number id, actor email for an admin, changes as a list or as an object", () => {
    const rows: AuditRow[] = auditEntity;
    expect(typeof rows[0]?.id).toBe("number");
    const admin = rows.find((r) => r.actor.startsWith("admin/"));
    expect(admin?.actorEmail).toBe("manager@beta.demo");
    expect(rows.find((r) => r.actor.startsWith("player/"))?.actorEmail).toBeNull();
    // A table change is a list of { field, from, to }; a platform call is a plain object.
    const created = rows.find((r) => r.action === "create");
    expect(changeLines(created?.changes)[0]).toMatch(/^id: null -> /);
    const call = rows.find((r) => r.action === "platform_call");
    expect(changeLines(call?.changes).some((l) => l.startsWith("call: "))).toBe(true);
    const page: Page<AuditRow & { cursor: string }> = alphaAuditRecent;
    expect(typeof page.nextCursor).toBe("string");
  });

  it("settings and settings changes", () => {
    const settings: SettingsData = alphaSettings;
    const change: SettingsChange | undefined = settings.changes[0];
    expect(typeof change?.expectedPrizeCoins).toBe("number");
    expect(change?.proposedByEmail).toBe("manager@alpha.demo");
    // The queue for the platform admin is a bare array with the same item shape.
    const queue: SettingsChange[] = platformChanges;
    expect(Array.isArray(queue)).toBe(true);
    expect(segmentsOf(queue[0]?.proposed).length).toBeGreaterThan(1);
    // The 201 and 202 answers carry the change; only the 201 carries the wheel version.
    const applied: { change: AnswerChange; wheelVersion: number } = wheelApplied;
    expect(applied.change.status).toBe("applied");
    expect(typeof applied.wheelVersion).toBe("number");
    const waiting: { change: AnswerChange } = wheelWaiting;
    expect(waiting.change.status).toBe("proposed");
    expect("wheelVersion" in waiting).toBe(false);
  });

  it("the page computes the same expected prize as the server for every stored wheel", () => {
    expect(alphaSettings.wheel.length).toBeGreaterThan(1);
    for (const w of alphaSettings.wheel) expect(expectedPrize(w.segments)).toBe(w.expectedPrizeCoins);
  });
});
