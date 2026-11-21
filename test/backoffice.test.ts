import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { create, record } from "../src/audit/audited.ts";
import { transaction } from "../src/db.ts";
import { COIN_LEDGER, type CoinLedger, LedgerUnavailable } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { ALPHA_MANAGER, ALPHA_VIEWER, BETA_MANAGER, OPS, adminHeaders } from "./admin-login.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { tokenFor } from "./signing.ts";

// Whole app over real HTTP, real PostgreSQL, real TigerBeetle, the fake casino as the platform.
// A long ledger time limit: a slow ledger on a busy machine must not turn a number into null here.
// The "ledger away" case below is tested by making the ledger throw.
const running = await startApp({ config: { ledgerTimeoutMs: 15_000 } });
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const ALPHA = "alpha-casino";
const BETA = "beta-casino";
const tenantOf = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};
const app = () => {
  if (!running || !fake) throw new Error("no app");
  return running;
};
const fakeUrl = () => (fake as FakeCasino).url;
const ledger = () => app().app.get<CoinLedger>(COIN_LEDGER);

beforeAll(async () => {
  if (running && fake) await seedDemo(running.db, running.clock, fake.url);
});
afterAll(async () => {
  await fake?.close();
  await running?.close();
});

/** A GET as a demo user. */
async function get(email: string, path: string) {
  const r = await fetch(`${app().url}${path}`, { headers: await adminHeaders(app(), email) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const mgr = (tenant: string) => (tenant === BETA ? BETA_MANAGER : ALPHA_MANAGER);
const list = async (tenant: string, path: string) => (await get(mgr(tenant), `/admin/${tenant}${path}`)).json;

interface Made {
  externalId: string;
  playerId: string;
  spinId: string;
  eventId: string;
  redemptionId: string;
}

/** The real flow: deposit through the fake casino, spin, give coins, redeem. Platform A answers at once. */
async function flow(tenantId: string, options: { redeem?: boolean; spin?: boolean } = {}): Promise<Made> {
  const externalId = `p-${randomUUID()}`;
  const dep = await fetch(`${fakeUrl()}/control/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId, playerId: externalId, amount: "20.00", currency: "EUR" }),
  });
  expect(dep.status).toBe(200);
  const token = () =>
    tokenFor(tenantId, tenantOf(tenantId).tokenSecret, externalId, app().clock.now().getTime());
  const auth = { authorization: `Bearer ${token()}` };
  const me = (await (await fetch(`${app().url}/me`, { headers: auth })).json()) as {
    playerId: string;
    spins: { id: string }[];
  };
  const spinId = me.spins[0]?.id as string;
  if (options.spin !== false) {
    const spun = await fetch(`${app().url}/wheel/spins/${spinId}/spin`, { method: "POST", headers: auth });
    expect(spun.status).toBe(200);
  }
  let redemptionId = "";
  if (options.redeem !== false) {
    await ledger().creditPrize({
      ledgerNo: tenantOf(tenantId).ledgerNo,
      playerId: me.playerId,
      spinId: randomUUID(),
      coins: 500n,
    });
    const item = (
      await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = 'bonus-1-eur'", [
        tenantId,
      ])
    ).rows[0].id;
    const r = await fetch(`${app().url}/store/redemptions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ itemId: item }),
    });
    redemptionId = ((await r.json()) as { id: string }).id;
  }
  const eventId = (
    await app().db.query(
      "SELECT e.id FROM inbound_events e JOIN players p ON p.id = e.player_id WHERE p.id = $1",
      [me.playerId],
    )
  ).rows[0].id;
  return { externalId, playerId: me.playerId, spinId, eventId, redemptionId };
}

let alpha: Made;
let beta: Made;
const ctx = (tenantId: string) => ({ tenantId, actor: "system/test", now: app().clock.now() });

beforeAll(async () => {
  if (!running || !fake) return;
  alpha = await flow(ALPHA);
  beta = await flow(BETA);
  // Jobs that ran inline are marked done by the next run; do it now so "due" is empty.
  await app().app.get<Outbox>(OUTBOX).drain();
  // An unused spin and a ignored event, so the filters have something to tell apart.
  await flow(ALPHA, { spin: false, redeem: false });
  await transaction(app().db, (tx) =>
    create(tx, ctx(ALPHA), "inbound_events", {
      tenant_id: ALPHA,
      external_event_id: `ign-${randomUUID()}`,
      kind: "ignored",
      normalized: { kind: "ignored" },
      raw: { type: "login" },
      received_at: app().clock.now(),
    }),
  );
});

describe.skipIf(!running)("back office reads", () => {
  test("each endpoint answers the documented shape", async () => {
    const o = await list(ALPHA, "/overview");
    expect(Object.keys(o).sort()).toEqual(
      [
        "alerts",
        "at",
        "coinsOutstanding",
        "events24h",
        "outbox",
        "players",
        "redemptions",
        "settings",
        "spins",
      ].sort(),
    );
    expect(Object.keys(o.redemptions).sort()).toEqual(
      ["created", "insufficient", "issued", "refused", "reserved", "submitting", "unsettled"].sort(),
    );
    expect(o.settings).toEqual({ wheelVersion: 1, grantPolicyVersion: 1, opsPolicyVersion: 1 });
    expect(typeof o.coinsOutstanding).toBe("string");

    const reds = await list(ALPHA, "/redemptions");
    expect(reds.nextCursor).toBeNull();
    const item = reds.items.find((i: { id: string }) => i.id === alpha.redemptionId);
    expect(Object.keys(item).sort()).toEqual(
      [
        "costCoins",
        "createdAt",
        "cursor",
        "id",
        "itemCode",
        "itemName",
        "platformRef",
        "playerExternalId",
        "playerId",
        "reason",
        "settled",
        "status",
        "updatedAt",
      ].sort(),
    );
    expect(item).toMatchObject({
      playerId: alpha.playerId,
      playerExternalId: alpha.externalId,
      itemCode: "bonus-1-eur",
      costCoins: "100",
      status: "issued",
      settled: true,
    });

    const players = await list(ALPHA, "/players");
    const pl = players.items.find((i: { id: string }) => i.id === alpha.playerId);
    expect(pl).toMatchObject({
      externalId: alpha.externalId,
      spinsAvailable: 0,
      spinsUsed: 1,
      redemptions: 1,
    });
    expect(typeof pl.cursor).toBe("string");

    const events = await list(ALPHA, "/events");
    const ev = events.items.find((i: { id: string }) => i.id === alpha.eventId);
    expect(ev).toMatchObject({
      kind: "deposit_succeeded",
      playerId: alpha.playerId,
      playerExternalId: alpha.externalId,
    });
    expect(ev.normalized).toBeTruthy();

    const spins = await list(ALPHA, "/spins");
    const sp = spins.items.find((i: { id: string }) => i.id === alpha.spinId);
    expect(sp).toMatchObject({ status: "used", wheelVersion: 1, playerId: alpha.playerId });
    expect(typeof sp.coins).toBe("string");
    expect(sp.creditedAt).not.toBeNull();

    const outbox = await list(ALPHA, "/outbox");
    expect(outbox.items.length).toBeGreaterThan(0);
    expect(Object.keys(outbox.items[0]).sort()).toEqual(
      ["attempts", "cursor", "deadAt", "doneAt", "id", "kind", "lastError", "refId", "runAt"].sort(),
    );

    const audit = await list(ALPHA, "/audit?recent=1");
    expect(Object.keys(audit.items[0]).sort()).toEqual(
      [
        "action",
        "actor",
        "actorEmail",
        "at",
        "changes",
        "cursor",
        "entityId",
        "entityType",
        "id",
        "requestId",
      ].sort(),
    );

    const settings = await list(ALPHA, "/settings");
    expect(settings.wheel).toHaveLength(1);
    expect(settings.wheel[0]).toMatchObject({ version: 1, expectedPrizeCoins: 60 });
    expect(settings.wheel[0].segments).toHaveLength(4);
    expect(settings.grantPolicies[0].params).toMatchObject({ spinsPerDeposit: 1 });
    expect(settings.opsPolicies[0].params).toMatchObject({ maxExpectedPrizeCoins: 100 });
    expect(settings.storeItems.map((i: { code: string }) => i.code)).toEqual(["bonus-1-eur", "bonus-5-eur"]);
    expect(settings.changes).toEqual([]);
  });

  test("details: redemption (audit oldest first, job), player, event", async () => {
    const d = await list(ALPHA, `/redemptions/${alpha.redemptionId}`);
    expect(d.redemption).toMatchObject({ id: alpha.redemptionId, status: "issued" });
    expect(d.reward).toMatchObject({ type: "bonus", amountMinor: 100, currency: "EUR" });
    const ids = d.audit.map((a: { id: number }) => a.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
    expect(d.audit[0]).toMatchObject({ action: "create", entityType: "redemptions" });
    expect(d.audit.some((a: { action: string }) => a.action === "platform_call")).toBe(true);
    expect(d.job).toMatchObject({ attempts: expect.any(Number), lastError: null });
    expect(d.job.doneAt).not.toBeNull();

    const p = await list(ALPHA, `/players/${alpha.playerId}`);
    expect(p.player).toMatchObject({ id: alpha.playerId, externalId: alpha.externalId });
    expect(p.balance).toEqual({ available: expect.any(String), reserved: "0" });
    expect(p.spins[0]).toMatchObject({
      id: alpha.spinId,
      status: "used",
      wheelVersion: 1,
      grantPolicyVersion: 1,
    });
    expect(p.redemptions.map((r: { id: string }) => r.id)).toEqual([alpha.redemptionId]);
    expect(p.events.map((e: { id: string }) => e.id)).toEqual([alpha.eventId]);

    const e = await list(ALPHA, `/events/${alpha.eventId}`);
    expect(e.id).toBe(alpha.eventId);
    expect(e.raw).toBeTruthy();
    expect(e.spins).toEqual([{ id: alpha.spinId, status: "used" }]);
  });

  test("filters", async () => {
    const issued = await list(ALPHA, "/redemptions?status=issued");
    expect(issued.items.every((i: { status: string }) => i.status === "issued")).toBe(true);
    expect(issued.items.length).toBeGreaterThan(0);
    expect((await list(ALPHA, "/redemptions?status=refused")).items).toEqual([]);
    const byPlayer = await list(ALPHA, `/redemptions?playerId=${alpha.playerId}`);
    expect(byPlayer.items.map((i: { id: string }) => i.id)).toEqual([alpha.redemptionId]);

    const ignored = await list(ALPHA, "/events?kind=ignored");
    expect(ignored.items).toHaveLength(1);
    expect((await list(ALPHA, "/events?kind=deposit_succeeded")).items.length).toBe(2);

    const avail = await list(ALPHA, "/spins?status=available");
    expect(avail.items).toHaveLength(1);
    expect(avail.items[0].coins).toBeNull();
    expect((await list(ALPHA, `/spins?playerId=${alpha.playerId}`)).items).toHaveLength(1);

    const q = await list(ALPHA, `/players?q=${alpha.externalId.slice(0, 12)}`);
    expect(q.items.map((i: { id: string }) => i.id)).toEqual([alpha.playerId]);
    expect((await list(ALPHA, "/players?q=zzz-none")).items).toEqual([]);
    expect((await list(ALPHA, "/players?q=%25")).items).toEqual([]); // "%" is text, not a wildcard

    expect((await list(ALPHA, "/outbox?state=done")).items.length).toBeGreaterThan(0);
    expect((await list(ALPHA, "/outbox?state=dead")).items).toEqual([]);
    expect((await list(ALPHA, "/outbox?state=due")).items).toEqual([]);
    expect((await list(ALPHA, "/outbox?state=waiting")).items).toEqual([]);

    const logins = await list(ALPHA, "/audit?recent=1&action=admin_login");
    expect(logins.items.every((a: { action: string }) => a.action === "admin_login")).toBe(true);
    const bySpin = await list(ALPHA, "/audit?recent=1&actor=player/");
    expect(bySpin.items.length).toBeGreaterThan(0);
    expect(bySpin.items.every((a: { actor: string }) => a.actor.startsWith("player/"))).toBe(true);
  });

  test("bad cursors, limits and filter values are 400", async () => {
    const paths = [
      "/redemptions?before=not-a-cursor",
      "/redemptions?before=",
      "/redemptions?limit=0",
      "/redemptions?limit=101",
      "/redemptions?limit=abc",
      "/redemptions?limit=5&limit=6",
      "/redemptions?status=maybe",
      "/redemptions?playerId=not-a-uuid",
      "/events?kind=x",
      "/spins?status=x",
      "/spins?playerId=1",
      "/outbox?state=x",
      "/outbox?before=%00",
      "/players?before=eyJ4Ijoie30",
      "/audit?recent=1&before=abc",
      "/audit",
      "/audit?recent=0",
    ];
    for (const path of paths) {
      const r = await get(ALPHA_MANAGER, `/admin/${ALPHA}${path}`);
      // "before=" (empty) means no cursor, which is fine.
      expect(r.status, path).toBe(path === "/redemptions?before=" ? 200 : 400);
    }
    expect((await get(ALPHA_MANAGER, `/admin/${ALPHA}/redemptions?limit=100`)).status).toBe(200);
    expect((await get(ALPHA_MANAGER, `/admin/${ALPHA}/redemptions?limit=1`)).json.items).toHaveLength(1);
  });

  test("pagination walks 120 rows in pages of 50 without a gap or a repeat while rows are added", async () => {
    // 120 redemptions, in groups with the same created_at, so the tie-break by id is used.
    const player = (
      await app().db.query("INSERT INTO players (tenant_id, external_id) VALUES ($1, $2) RETURNING id", [
        BETA,
        `page-${randomUUID()}`,
      ])
    ).rows[0].id as string;
    const item = (
      await app().db.query("SELECT id, reward FROM store_items WHERE tenant_id = $1 LIMIT 1", [BETA])
    ).rows[0];
    const base = Date.parse("2020-01-01T00:00:00Z");
    const addRedemption = (n: number, at: number) =>
      transaction(app().db, (tx) =>
        create(tx, ctx(BETA), "redemptions", {
          tenant_id: BETA,
          player_id: player,
          idempotency_key: `page-${n}-${randomUUID()}`,
          item_id: item.id,
          cost_coins: 100,
          reward: item.reward,
          status: "insufficient",
          created_at: new Date(at),
          updated_at: new Date(at),
        }),
      );
    const made: string[] = [];
    for (let i = 0; i < 120; i++)
      made.push(((await addRedemption(i, base + Math.floor(i / 10) * 1000)) as { id: string }).id);

    const walk = async (
      path: string,
      idOf: (i: Record<string, unknown>) => string,
      between: () => Promise<void>,
    ) => {
      const seen: string[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const sep = path.includes("?") ? "&" : "?";
        const page: { items: Record<string, unknown>[]; nextCursor: string | null } = (
          await get(BETA_MANAGER, `/admin/${BETA}${path}${sep}limit=50${before ? `&before=${before}` : ""}`)
        ).json;
        expect(page.items.length).toBeLessThanOrEqual(50);
        for (const i of page.items) seen.push(idOf(i));
        before = page.nextCursor;
        pages++;
        if (before) await between();
      } while (before);
      return { seen, pages };
    };

    // Rows are added between pages. They are newer than everything and so sit before the cursor.
    let extra = 0;
    const newer = async () => {
      await addRedemption(1000 + extra, base + 10_000_000 + extra);
      extra++;
    };
    const { seen, pages } = await walk(`/redemptions?playerId=${player}`, (i) => i.id as string, newer);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length); // no repeat
    expect(seen.length).toBe(120);
    for (const id of made) expect(seen).toContain(id); // no gap
    // The order is newest first, by (created_at, id).
    const rows = (await get(BETA_MANAGER, `/admin/${BETA}/redemptions?playerId=${player}&limit=100`)).json
      .items;
    expect(rows.slice(0, 2).map((r: { createdAt: string }) => r.createdAt)).toEqual(
      [...rows.slice(0, 2).map((r: { createdAt: string }) => r.createdAt)].sort().reverse(),
    );

    // The same for a list keyed by a number: the audit trail.
    await transaction(app().db, async (tx) => {
      for (let i = 0; i < 120; i++) {
        await record(tx, ctx(BETA), { action: "page_test", entityType: "x", entityId: `row-${i}` });
      }
    });
    const audit = await walk(
      "/audit?recent=1&action=page_test",
      (i) => i.entityId as string,
      async () => {
        await transaction(app().db, (tx) =>
          record(tx, ctx(BETA), { action: "page_test", entityType: "x", entityId: "late" }),
        );
      },
    );
    expect(audit.seen.filter((x) => x.startsWith("row-"))).toHaveLength(120);
    expect(new Set(audit.seen).size).toBe(audit.seen.length);
    expect(audit.seen).not.toContain("late"); // added after the walk began, newer than the cursor
  });

  test("tenant isolation: beta's manager sees none of alpha's rows, and gets 404 for alpha's ids and paths", async () => {
    const alphaIds = new Set([alpha.redemptionId, alpha.playerId, alpha.spinId, alpha.eventId]);
    const lists = ["redemptions", "players", "events", "spins", "outbox", "audit?recent=1"];
    for (const l of lists) {
      const sep = l.includes("?") ? "&" : "?";
      const body = JSON.stringify((await get(BETA_MANAGER, `/admin/${BETA}/${l}${sep}limit=100`)).json);
      for (const id of alphaIds) expect(body, `${l} holds ${id}`).not.toContain(id);
      // And alpha's own page holds them (so the check above can fail).
    }
    for (const l of ["redemptions", "players", "events", "spins"]) {
      const own = JSON.stringify((await get(ALPHA_MANAGER, `/admin/${ALPHA}/${l}?limit=100`)).json);
      expect(own.length).toBeGreaterThan(50);
    }
    // Alpha's ids on beta's own path: the query filter says not found.
    for (const path of [
      `/redemptions/${alpha.redemptionId}`,
      `/players/${alpha.playerId}`,
      `/events/${alpha.eventId}`,
    ]) {
      expect((await get(BETA_MANAGER, `/admin/${BETA}${path}`)).status, path).toBe(404);
      expect((await get(BETA_MANAGER, `/admin/${ALPHA}${path}`)).status, path).toBe(404);
      expect((await get(OPS, `/admin/${BETA}${path}`)).status, `ops ${path}`).toBe(404);
      expect((await get(OPS, `/admin/${ALPHA}${path}`)).status, `ops ${path}`).toBe(200);
    }
    // Filters cannot reach across: alpha's player id on beta's lists gives nothing.
    expect((await list(BETA, `/redemptions?playerId=${alpha.playerId}`)).items).toEqual([]);
    expect((await list(BETA, `/spins?playerId=${alpha.playerId}`)).items).toEqual([]);
    // Beta's own rows are there.
    expect((await list(BETA, `/redemptions?playerId=${beta.playerId}`)).items).toHaveLength(1);
    expect((await get(BETA_MANAGER, `/admin/${ALPHA}/overview`)).status).toBe(404);
    expect((await get(BETA_MANAGER, `/admin/${ALPHA}/settings`)).status).toBe(404);
    // Ids that are not ids are 404, not 500.
    expect((await get(ALPHA_MANAGER, `/admin/${ALPHA}/redemptions/not-an-id`)).status).toBe(404);
    expect((await get(ALPHA_MANAGER, `/admin/${ALPHA}/players/${randomUUID()}`)).status).toBe(404);
  });

  test("a viewer can read all of it", async () => {
    for (const path of [
      "/overview",
      "/redemptions",
      `/redemptions/${alpha.redemptionId}`,
      "/players",
      `/players/${alpha.playerId}`,
      "/events",
      `/events/${alpha.eventId}`,
      "/spins",
      "/outbox",
      "/audit?recent=1",
      `/audit?entityId=${alpha.spinId}`,
      "/settings",
      "/alerts",
      "/redemptions/stuck",
    ]) {
      expect((await get(ALPHA_VIEWER, `/admin/${ALPHA}${path}`)).status, path).toBe(200);
    }
    expect((await get(ALPHA_VIEWER, `/admin/${BETA}/overview`)).status).toBe(404);
    expect((await get("viewer@alpha.demo", "/admin/auth/me")).json).toMatchObject({ role: "tenant_viewer" });
    // No token at all.
    expect((await fetch(`${app().url}/admin/${ALPHA}/overview`)).status).toBe(401);
  });

  test("/platform/tenants: the platform admin sees both, anyone else only their own", async () => {
    const all = (await get(OPS, "/platform/tenants")).json;
    expect(all).toEqual([
      { id: ALPHA, name: "Alpha Casino", platform: "A" },
      { id: BETA, name: "Beta Casino", platform: "B" },
    ]);
    expect((await get(BETA_MANAGER, "/platform/tenants")).json).toEqual([
      { id: BETA, name: "Beta Casino", platform: "B" },
    ]);
    expect((await get(ALPHA_VIEWER, "/platform/tenants")).json).toEqual([
      { id: ALPHA, name: "Alpha Casino", platform: "A" },
    ]);
    expect((await fetch(`${app().url}/platform/tenants`)).status).toBe(401);
  });

  test("overview numbers equal counts computed by SQL", async () => {
    const ledgerBefore = await ledger().outstanding({ ledgerNo: tenantOf(ALPHA).ledgerNo });
    const o = await list(ALPHA, "/overview");
    const n = async (sql: string, params: unknown[] = []) =>
      Number((await app().db.query(sql, [ALPHA, ...params])).rows[0].n);
    expect(o.players).toBe(await n("SELECT count(*) AS n FROM players WHERE tenant_id = $1"));
    expect(o.spins.available).toBe(
      await n("SELECT count(*) AS n FROM spins WHERE tenant_id = $1 AND status = 'available'"),
    );
    expect(o.spins.used).toBe(
      await n("SELECT count(*) AS n FROM spins WHERE tenant_id = $1 AND status = 'used'"),
    );
    for (const s of ["created", "reserved", "submitting", "issued", "refused", "insufficient"]) {
      expect(o.redemptions[s], s).toBe(
        await n("SELECT count(*) AS n FROM redemptions WHERE tenant_id = $1 AND status = $2", [s]),
      );
    }
    expect(o.redemptions.unsettled).toBe(
      await n(
        "SELECT count(*) AS n FROM redemptions WHERE tenant_id = $1 AND status IN ('issued','refused') AND settled_at IS NULL",
      ),
    );
    expect(o.events24h.ignored).toBe(
      await n("SELECT count(*) AS n FROM inbound_events WHERE tenant_id = $1 AND kind = 'ignored'"),
    );
    expect(o.events24h.accepted).toBe(
      await n("SELECT count(*) AS n FROM inbound_events WHERE tenant_id = $1 AND kind <> 'ignored'"),
    );
    expect(o.outbox.dead).toBe(
      await n("SELECT count(*) AS n FROM outbox WHERE tenant_id = $1 AND dead_at IS NOT NULL"),
    );
    expect(o.alerts).toEqual({ critical: 0, warning: 0 });
    // Coins outstanding is the ledger's number: what was issued minus what players spent.
    // The ledger is read before and after the call: under load a transfer whose client call timed out
    // can still land in between, and the page must show one of the two real numbers.
    // Found on CI: the page showed a third number, because transfers from earlier tests of this file were
    // still landing. So: read the ledger, the page, the ledger again, and compare only when the ledger
    // stood still across the call; try again otherwise.
    void ledgerBefore;
    let compared = false;
    for (let i = 0; i < 50 && !compared; i++) {
      const before = await ledger().outstanding({ ledgerNo: tenantOf(ALPHA).ledgerNo });
      const page = await list(ALPHA, "/overview");
      const after = await ledger().outstanding({ ledgerNo: tenantOf(ALPHA).ledgerNo });
      if (before === after) {
        expect(page.coinsOutstanding).toBe(String(before));
        compared = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(compared, "the ledger never stood still for one call").toBe(true);
    // Beta has its own, different numbers.
    const b = await list(BETA, "/overview");
    expect(b.players).toBe(
      await Number(
        (await app().db.query("SELECT count(*) AS n FROM players WHERE tenant_id = $1", [BETA])).rows[0].n,
      ),
    );
  });

  test("events older than 24 hours are not in events24h", async () => {
    const before = (await list(ALPHA, "/overview")).events24h.accepted;
    app().clock.advance(25 * 60 * 60 * 1000);
    try {
      const after = (await list(ALPHA, "/overview")).events24h;
      expect(after.accepted).toBe(0);
      expect(before).toBeGreaterThan(0);
    } finally {
      // The clock only moves forward, so the later tests simply run a day later.
    }
  });

  test("the ledger being away gives null, not 500", async () => {
    const coins = ledger();
    const outstanding = coins.outstanding.bind(coins);
    const balance = coins.balance.bind(coins);
    coins.outstanding = async () => {
      throw new LedgerUnavailable("ledger away (test)");
    };
    coins.balance = async () => {
      throw new LedgerUnavailable("ledger away (test)");
    };
    try {
      const o = await get(ALPHA_MANAGER, `/admin/${ALPHA}/overview`);
      expect(o.status).toBe(200);
      expect(o.json.coinsOutstanding).toBeNull();
      expect(o.json.players).toBeGreaterThan(0);
      const p = await get(ALPHA_MANAGER, `/admin/${ALPHA}/players/${alpha.playerId}`);
      expect(p.status).toBe(200);
      expect(p.json.balance).toBeNull();
      expect(p.json.spins).toHaveLength(1);
    } finally {
      coins.outstanding = outstanding;
      coins.balance = balance;
    }
  });
});
