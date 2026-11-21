import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { ALPHA_MANAGER, BETA_MANAGER, OPS, adminHeaders } from "./admin-login.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { alphaDeposit, betaTxn, playerToken, signAlpha, signBeta, tokenFor } from "./signing.ts";

/**
 * Tenant isolation, checked per route.
 *
 * Isolation is enforced in code: every query filters by tenant. The weak point is a NEW route whose
 * query forgets the filter. This test closes that gap by forcing a decision for every route:
 *
 *  - It reads every HTTP route of the running app from the framework (the Express router stack).
 *  - Each route must be in CHECKED (a check that runs) or in SKIPPED (a reason).
 *  - A route in neither list fails: "New route ...: decide".
 *  - An entry that matches no live route fails ("stale entry"), and so does a route in both lists.
 *
 * The actor is BETA (the attacker); the victim is ALPHA. Both tenants get real data through the public
 * flow first. Every table with a `tenant_id` column is found in the database, and the primary keys of
 * alpha's rows (and a few other identifiers) become the list of values that must never appear in a
 * beta answer. For writes, all of alpha's rows are compared before and after.
 */

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
const now = () => app().clock.now().getTime();
const query = (sql: string, params: unknown[] = []) => app().db.query(sql, params);

// ---------------------------------------------------------------------------------------------
// The two lists
// ---------------------------------------------------------------------------------------------

type Check = () => Promise<void>;

/** Route -> why tenant isolation does not apply. */
const SKIPPED: Record<string, string> = {
  "GET /health": "no tenant data: it only reports whether PostgreSQL and the ledger answer",
  "POST /admin/auth/login":
    "no tenant data before sign-in: it takes an email and a password and returns a token",
  "MIDDLEWARE web":
    "static files of the web app (/app/...) and /app-config.json: no tenant rows (demo sign-in accounts only in demo mode)",
  "ALL /{*path}": "Nest middleware that runs for every path (request id, tracing): it reads no tenant data",
};

/** Route -> how it is checked. Filled at the end of this file, after the helpers. */
const CHECKED: Record<string, Check> = {};

// ---------------------------------------------------------------------------------------------
// Reading the routes from the framework
// ---------------------------------------------------------------------------------------------

interface Layer {
  name: string;
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Every route the running app answers, as "METHOD /path/:param", read from the Express router stack
 * (Express 5: `router.stack`). A route for all methods is "ALL <path>". Middleware that serves files
 * (the web app) is "MIDDLEWARE web"; any other named middleware shows up as "MIDDLEWARE <name>" so a
 * new one has to be decided on as well. Body parsers and anonymous layers carry no data and are ignored.
 */
function liveRoutes(): string[] {
  const instance = app().app.getHttpAdapter().getInstance() as { router?: { stack: Layer[] } };
  const stack = instance.router?.stack;
  if (!stack) throw new Error("cannot read the router stack of this adapter");
  const keys = new Set<string>();
  const ignored = new Set(["query", "expressInit", "jsonParser", "urlencodedParser", "<anonymous>"]);
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.entries(layer.route.methods)
        .filter(([, on]) => on)
        .map(([m]) => m.toUpperCase());
      if (methods.length > 10) keys.add(`ALL ${layer.route.path}`);
      else for (const m of methods) keys.add(`${m} ${layer.route.path}`);
    } else if (layer.name === "handler") {
      keys.add("MIDDLEWARE web");
    } else if (!ignored.has(layer.name)) {
      keys.add(`MIDDLEWARE ${layer.name}`);
    }
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: a parsed answer of any shape
type Json = any;

interface Answer {
  status: number;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a parsed answer of any shape
  json: any;
}
async function answer(r: Response): Promise<Answer> {
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the text is kept
  }
  return { status: r.status, text, json };
}

async function adminCall(email: string, method: string, path: string, body?: unknown): Promise<Answer> {
  return answer(
    await fetch(`${app().url}${path}`, {
      method,
      headers: await adminHeaders(app(), email, { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const asBeta = (method: string, path: string, body?: unknown) => adminCall(BETA_MANAGER, method, path, body);
const asOps = (method: string, path: string, body?: unknown) => adminCall(OPS, method, path, body);

const playerCall = async (
  tenantId: string,
  externalId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> =>
  answer(
    await fetch(`${app().url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenFor(tenantId, tenantOf(tenantId).tokenSecret, externalId, now())}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

async function fakePost(path: string, body: unknown = {}) {
  const r = await fetch(`${fakeUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
}

// ---------------------------------------------------------------------------------------------
// The data: both tenants, made through the public flow
// ---------------------------------------------------------------------------------------------

interface Player {
  externalId: string;
  id: string;
  spinIds: string[];
  redemptionId: string | null;
}
interface World {
  tenantId: string;
  /** Has a used spin and an issued redemption. */
  used: Player;
  /** Has an unused spin and coins. */
  fresh: Player;
  itemId: string;
  /** Redemptions that stay `submitting`: the answer never came. */
  stuck: { player: Player; id: string }[];
  waitingChangeId: string;
}
const worlds: Record<string, World> = {};
const alpha = () => worlds[ALPHA] as World;
const beta = () => worlds[BETA] as World;

const CHEAP = [
  { label: "5 coins", coins: 5, weight: 3 },
  { label: "50 coins", coins: 50, weight: 1 },
];
const RICH = [
  { label: "1000 coins", coins: 1000, weight: 1 },
  { label: "1 coin", coins: 1, weight: 1 },
];

async function makePlayer(tenantId: string, coins: bigint, spin: boolean): Promise<Player> {
  const externalId = `p-${randomUUID()}`;
  await fakePost("/control/deposit", { tenantId, playerId: externalId, amount: "20.00", currency: "EUR" });
  const me = (await playerCall(tenantId, externalId, "GET", "/me")).json as {
    playerId: string;
    spins: { id: string }[];
  };
  const spinIds = me.spins.map((s) => s.id);
  if (spin)
    expect((await playerCall(tenantId, externalId, "POST", `/wheel/spins/${spinIds[0]}/spin`)).status).toBe(
      200,
    );
  if (coins > 0n) {
    await app()
      .app.get<CoinLedger>(COIN_LEDGER)
      .creditPrize({
        ledgerNo: tenantOf(tenantId).ledgerNo,
        playerId: me.playerId,
        spinId: randomUUID(),
        coins,
      });
  }
  return { externalId, id: me.playerId, spinIds, redemptionId: null };
}

async function redeem(tenantId: string, p: Player, itemId: string): Promise<{ id: string; status: string }> {
  const r = await playerCall(tenantId, p.externalId, "POST", "/store/redemptions", { itemId });
  expect([200, 201]).toContain(r.status);
  return r.json;
}

async function build(tenantId: string, manager: string): Promise<World> {
  const itemId = (
    await query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = 'bonus-1-eur'", [tenantId])
  ).rows[0].id as string;
  const used = await makePlayer(tenantId, 500n, true);
  used.redemptionId = (await redeem(tenantId, used, itemId)).id;
  const fresh = await makePlayer(tenantId, 500n, false);

  // Redemptions without a final answer. Platform B: the callback is lost. Platform A: the grant call
  // is lost and the look-up fails, so the redemption cannot settle itself.
  const stuck: World["stuck"] = [];
  const howMany = tenantId === BETA ? 3 : 1;
  for (let i = 0; i < howMany; i++) {
    const player = await makePlayer(tenantId, 500n, false);
    if (tenantId === BETA)
      await fakePost("/control/faults", { point: "b.callback", fault: "lost", times: 1, tenantId });
    else {
      await fakePost("/control/faults", { point: "a.grant", fault: "lost_request", times: 1, tenantId });
      await fakePost("/control/faults", { point: "a.find", fault: "error_500", times: 50, tenantId });
    }
    const r = await redeem(tenantId, player, itemId);
    expect(r.status, "setup: the redemption must stay unfinished").toBe("submitting");
    if (tenantId === BETA) await fakePost("/control/b/deliver");
    stuck.push({ player, id: r.id });
  }
  await fakePost("/control/reset");

  // A settings change that applies at once (a new wheel version) and one that waits for the platform.
  const cheap = await adminCall(manager, "POST", `/admin/${tenantId}/settings/wheel`, { segments: CHEAP });
  expect(cheap.status).toBe(201);
  const waiting = await adminCall(manager, "POST", `/admin/${tenantId}/settings/wheel`, { segments: RICH });
  expect(waiting.status).toBe(202);
  return { tenantId, used, fresh, itemId, stuck, waitingChangeId: waiting.json.change.id };
}

// ---------------------------------------------------------------------------------------------
// Database view: tables with tenant_id, identifiers, snapshots
// ---------------------------------------------------------------------------------------------

interface TenantTable {
  table: string;
  pk: string[];
}
let tables: TenantTable[] = [];
/** Values of alpha's primary keys and a few other identifiers, with where each one came from. */
let alphaIds: { value: string; source: string }[] = [];

async function discoverTables(): Promise<TenantTable[]> {
  const found = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
  );
  const out: TenantTable[] = [];
  for (const { table_name } of found.rows) {
    const pk = await query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [`public.${table_name}`],
    );
    out.push({ table: table_name, pk: pk.rows.map((r) => r.attname) });
  }
  return out;
}

/** Other identifying values that are not primary keys, but would leak the same way. */
const EXTRA: [string, string][] = [
  ["players", "external_id"],
  ["inbound_events", "external_event_id"],
  ["redemptions", "platform_ref"],
  ["admin_users", "email"],
];

async function collectIds(tenantId: string) {
  const out: { value: string; source: string }[] = [];
  const long = (v: unknown): v is string => typeof v === "string" && v.length >= 8; // skips bigserial ids
  for (const { table, pk } of tables) {
    for (const col of pk) {
      for (const row of (await query(`SELECT ${col} AS v FROM ${table} WHERE tenant_id = $1`, [tenantId]))
        .rows) {
        if (long(row.v)) out.push({ value: row.v, source: `${table}.${col}` });
      }
    }
  }
  for (const [table, col] of EXTRA) {
    for (const row of (await query(`SELECT ${col} AS v FROM ${table} WHERE tenant_id = $1`, [tenantId]))
      .rows) {
      if (long(row.v)) out.push({ value: row.v, source: `${table}.${col}` });
    }
  }
  const t = tenantOf(tenantId);
  out.push({ value: t.id, source: "tenant id" });
  for (const k of ["webhookSecret", "tokenSecret", "wheelSecret", "platformKey"] as const) {
    out.push({ value: t[k], source: `tenant ${k}` });
  }
  return out;
}

/** Every row of the tenant in every table that has tenant_id, plus its own tenants row. */
async function snapshot(tenantId: string, skip: string[] = []): Promise<Record<string, string[]>> {
  const parts: Record<string, string[]> = {};
  for (const { table } of tables) {
    if (skip.includes(table)) continue;
    const r = await query(`SELECT to_jsonb(t)::text AS r FROM ${table} t WHERE tenant_id = $1`, [tenantId]);
    parts[table] = r.rows.map((x) => x.r).sort();
  }
  parts.tenants = (
    await query("SELECT to_jsonb(t)::text AS r FROM tenants t WHERE id = $1", [tenantId])
  ).rows.map((x) => x.r);
  return parts;
}

function noAlphaIds(text: string, what: string) {
  for (const { value, source } of alphaIds) {
    if (text.includes(value)) throw new Error(`${what} shows alpha's ${source} (${value})`);
  }
}

function sameRows(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
  what: string,
  tenant: string,
) {
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (changed.length) throw new Error(`${what} changed ${tenant}'s data in: ${changed.join(", ")}`);
}

async function untouched(tenant: string, before: Record<string, string[]>, what: string) {
  sameRows(before, await snapshot(tenant), what, tenant);
}

/** Rejected webhooks are audited under the tenant of the path: that is the only change allowed. */
async function onlyRejectionsAdded(
  tenant: string,
  before: Record<string, string[]>,
  auditBefore: number,
  what: string,
) {
  sameRows(before, await snapshot(tenant, ["audit_log"]), what, tenant);
  const added = await query("SELECT action FROM audit_log WHERE tenant_id = $1 AND id > $2", [
    tenant,
    auditBefore,
  ]);
  for (const row of added.rows) {
    if (!["webhook_rejected", "webhook_invalid"].includes(row.action)) {
      throw new Error(`${what} added an audit row '${row.action}' for ${tenant}`);
    }
  }
}
const lastAuditId = async () =>
  (await query("SELECT coalesce(max(id), 0)::int AS n FROM audit_log")).rows[0].n as number;

// ---------------------------------------------------------------------------------------------
// Check builders
// ---------------------------------------------------------------------------------------------

/** Follows `nextCursor` to the end, with a small page so that paging is really used. */
async function pageAll(path: string): Promise<{ text: string; items: number; pages: number }> {
  let text = "";
  let items = 0;
  let pages = 0;
  let before: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r = await asBeta("GET", `${path}${sep}limit=2${before ? `&before=${before}` : ""}`);
    expect(r.status, `GET ${path}`).toBe(200);
    text += r.text;
    items += r.json.items.length;
    pages++;
    before = r.json.nextCursor;
  } while (before && pages < 50);
  return { text, items, pages };
}

/** Beta's tenant admin walks into alpha's path. Every `/admin/:tenantId/...` route gets this. */
async function pathGuard(method: string, template: string, params: Record<string, string> = {}) {
  const path = template.replace(/:(\w+)/g, (_, k: string) => (k === "tenantId" ? ALPHA : (params[k] ?? "x")));
  const body = BODIES[`${method} ${template}`];
  const before = await snapshot(ALPHA);
  const r = await asBeta(method, path, body);
  expect(r.status, `${method} ${path} as beta's manager`).toBe(404);
  noAlphaIds(r.text, `${method} ${path}`);
  await untouched(ALPHA, before, `${method} ${path} as beta's manager`);
}

const BODIES: Record<string, unknown> = {
  "POST /admin/:tenantId/redemptions/:id/resolve": { outcome: "refused", note: "isolation check" },
  "POST /admin/:tenantId/settings/wheel": { segments: CHEAP },
  "POST /admin/:tenantId/keys/:kind/rotate": { previousValidForSec: 0 },
  "POST /admin/:tenantId/keys/:kind/revoke-previous": {},
};

/** A collection in beta's own path: alpha's path is 404; paged to the end; no alpha identifier; not empty. */
const listRoute =
  (route: string, suffix: string): Check =>
  async () => {
    await pathGuard("GET", `/admin/:tenantId${route}`);
    const got = await pageAll(`/admin/${BETA}${suffix}`);
    expect(got.items, `${route} of beta is empty: the check would prove nothing`).toBeGreaterThan(0);
    noAlphaIds(got.text, `GET ${route}`);
  };

/** An answer that is not paged. `has` tells that beta's answer holds something. */
const readRoute =
  (route: string, has: (json: Json) => boolean): Check =>
  async () => {
    await pathGuard("GET", `/admin/:tenantId${route}`);
    const r = await asBeta("GET", `/admin/${BETA}${route}`);
    expect(r.status, `GET ${route}`).toBe(200);
    expect(has(r.json), `${route} of beta is empty: the check would prove nothing`).toBe(true);
    noAlphaIds(r.text, `GET ${route}`);
  };

/** An item route: alpha's id in beta's own path is 404; beta's own id is 200 and clean. */
const itemRoute =
  (route: string, own: () => string, theirs: () => string): Check =>
  async () => {
    await pathGuard("GET", `/admin/:tenantId${route}`, { id: theirs() });
    const mine = await asBeta("GET", `/admin/${BETA}${route.replace(":id", own())}`);
    expect(mine.status, `own id on ${route}`).toBe(200);
    noAlphaIds(mine.text, `GET ${route} (own id)`);
    const other = await asBeta("GET", `/admin/${BETA}${route.replace(":id", theirs())}`);
    expect(other.status, `alpha's id inside beta's path on ${route}`).toBe(404);
  };

const eventIdOf = async (tenantId: string) =>
  (await query("SELECT id FROM inbound_events WHERE tenant_id = $1 ORDER BY received_at LIMIT 1", [tenantId]))
    .rows[0].id as string;

const hasItems = (j: Json) => Array.isArray(j?.items) && j.items.length > 0;

// -- Back office: reads
CHECKED["GET /admin/:tenantId/overview"] = readRoute("/overview", (j) => j && typeof j === "object");
CHECKED["GET /admin/:tenantId/alerts"] = readRoute("/alerts", (j) => j.alerts.length > 0);
CHECKED["GET /admin/:tenantId/redemptions/stuck"] = readRoute("/redemptions/stuck", hasItems);
CHECKED["GET /admin/:tenantId/settings"] = readRoute(
  "/settings",
  (j) => j.wheel.length > 0 && j.changes.length > 0,
);
CHECKED["GET /admin/:tenantId/keys"] = readRoute(
  "/keys",
  (j) => (Array.isArray(j) ? j : Object.keys(j)).length > 0,
);
CHECKED["GET /admin/:tenantId/redemptions"] = listRoute("/redemptions", "/redemptions");
CHECKED["GET /admin/:tenantId/players"] = listRoute("/players", "/players");
CHECKED["GET /admin/:tenantId/events"] = listRoute("/events", "/events");
CHECKED["GET /admin/:tenantId/spins"] = listRoute("/spins", "/spins");
CHECKED["GET /admin/:tenantId/outbox"] = listRoute("/outbox", "/outbox");
CHECKED["GET /admin/:tenantId/redemptions/:id"] = itemRoute(
  "/redemptions/:id",
  () => beta().used.redemptionId as string,
  () => alpha().used.redemptionId as string,
);
CHECKED["GET /admin/:tenantId/players/:id"] = itemRoute(
  "/players/:id",
  () => beta().used.id,
  () => alpha().used.id,
);
CHECKED["GET /admin/:tenantId/events/:id"] = async () => {
  const own = await eventIdOf(BETA);
  const theirs = await eventIdOf(ALPHA);
  await itemRoute(
    "/events/:id",
    () => own,
    () => theirs,
  )();
};

CHECKED["GET /admin/:tenantId/audit"] = async () => {
  await pathGuard("GET", "/admin/:tenantId/audit?recent=1");
  await pathGuard("GET", "/admin/:tenantId/audit?entityId=:id", { id: alpha().used.redemptionId as string });
  const got = await pageAll(`/admin/${BETA}/audit?recent=1`);
  expect(got.items, "beta's audit trail is empty: the check would prove nothing").toBeGreaterThan(0);
  noAlphaIds(got.text, "GET /audit?recent=1");
  // Alpha's entity asked for inside beta's path: an empty list, not alpha's rows.
  const asked = await asBeta("GET", `/admin/${BETA}/audit?entityId=${alpha().used.redemptionId}`);
  expect(asked.status).toBe(200);
  expect(asked.json).toEqual([]);
  const own = await asBeta("GET", `/admin/${BETA}/audit?entityId=${beta().used.redemptionId}`);
  expect(own.json.length, "beta's own entity has an audit trail").toBeGreaterThan(0);
};

// -- Back office: writes
CHECKED["POST /admin/:tenantId/redemptions/:id/resolve"] = async () => {
  const theirs = alpha().stuck[0]?.id as string;
  await pathGuard("POST", "/admin/:tenantId/redemptions/:id/resolve", { id: theirs });
  // Alpha's id inside beta's own path: not found, and alpha's redemption is still waiting.
  const before = await snapshot(ALPHA);
  const r = await asBeta(
    "POST",
    `/admin/${BETA}/redemptions/${theirs}/resolve`,
    BODIES["POST /admin/:tenantId/redemptions/:id/resolve"],
  );
  expect(r.status, "alpha's redemption through beta's path").toBe(404);
  await untouched(ALPHA, before, "resolve of alpha's redemption through beta's path");
  // The same call on beta's own stuck redemption works (so the 404 above is about the tenant).
  const own = await asBeta(
    "POST",
    `/admin/${BETA}/redemptions/${(beta().stuck[1] as { id: string }).id}/resolve`,
    {
      outcome: "refused",
      note: "isolation check",
    },
  );
  expect(own.status).toBe(200);
};
CHECKED["POST /admin/:tenantId/settings/wheel"] = async () => {
  await pathGuard("POST", "/admin/:tenantId/settings/wheel");
};
CHECKED["POST /admin/:tenantId/keys/:kind/rotate"] = async () => {
  await pathGuard("POST", "/admin/:tenantId/keys/:kind/rotate", { kind: "event_signing" });
  await pathGuard("POST", "/admin/:tenantId/keys/:kind/rotate", { kind: "player_token" });
};
CHECKED["POST /admin/:tenantId/keys/:kind/revoke-previous"] = async () => {
  await pathGuard("POST", "/admin/:tenantId/keys/:kind/revoke-previous", { kind: "event_signing" });
};

// -- Back office: who is signed in, and the platform admin's own routes
CHECKED["GET /admin/auth/me"] = async () => {
  const r = await asBeta("GET", "/admin/auth/me");
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ email: BETA_MANAGER, tenantId: BETA });
  noAlphaIds(r.text, "GET /admin/auth/me");
};
CHECKED["GET /platform/tenants"] = async () => {
  const mine = await asBeta("GET", "/platform/tenants");
  expect(mine.status).toBe(200);
  expect(mine.json.map((t: { id: string }) => t.id)).toEqual([BETA]);
  noAlphaIds(mine.text, "GET /platform/tenants");
  const ops = await asOps("GET", "/platform/tenants"); // cross-tenant by design for the platform admin
  expect(ops.json.map((t: { id: string }) => t.id).sort()).toEqual([ALPHA, BETA]);
};
CHECKED["GET /platform/settings-changes"] = async () => {
  for (const q of ["", "?status=proposed", "?status=applied"]) {
    const r = await asBeta("GET", `/platform/settings-changes${q}`);
    expect(r.status, `tenant admin on /platform/settings-changes${q}`).toBe(403);
    noAlphaIds(r.text, "GET /platform/settings-changes");
  }
  const ops = await asOps("GET", "/platform/settings-changes?status=proposed"); // so the 403 is not vacuous
  expect(JSON.stringify(ops.json)).toContain(alpha().waitingChangeId);
};
const decideRefused =
  (what: "approve" | "reject"): Check =>
  async () => {
    const before = await snapshot(ALPHA);
    const r = await asBeta("POST", `/platform/settings-changes/${alpha().waitingChangeId}/${what}`, {
      note: "isolation check",
    });
    expect(r.status, `tenant admin tries to ${what} alpha's change`).toBe(403);
    await untouched(ALPHA, before, `${what} of alpha's change by beta's manager`);
  };
CHECKED["POST /platform/settings-changes/:id/approve"] = decideRefused("approve");
CHECKED["POST /platform/settings-changes/:id/reject"] = decideRefused("reject");

// -- Player API: the tenant comes from the token only
CHECKED["GET /me"] = async () => {
  const p = beta().used;
  const r = await playerCall(BETA, p.externalId, "GET", "/me");
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ playerId: p.id, tenantId: BETA });
  expect(r.json.spins.length, "beta's player has spins").toBeGreaterThan(0);
  noAlphaIds(r.text, "GET /me");
  // A token signed with the other tenant's secret is refused, whichever tenant it names.
  const before = await snapshot(ALPHA);
  const forged = [
    playerToken(tenantOf(BETA).tokenSecret, {
      iss: ALPHA,
      sub: alpha().used.externalId,
      exp: Math.floor(now() / 1000) + 600,
    }),
    playerToken(tenantOf(ALPHA).tokenSecret, {
      iss: BETA,
      sub: p.externalId,
      exp: Math.floor(now() / 1000) + 600,
    }),
  ];
  for (const t of forged) {
    const bad = await fetch(`${app().url}/me`, { headers: { authorization: `Bearer ${t}` } });
    expect(bad.status).toBe(401);
  }
  // The same external id in two tenants is two players.
  const same = await playerCall(BETA, alpha().used.externalId, "GET", "/me");
  expect(same.status).toBe(200);
  expect(same.json.tenantId).toBe(BETA);
  expect(same.json.playerId).not.toBe(alpha().used.id);
  expect(same.json.spins).toEqual([]);
  await untouched(ALPHA, before, "tokens of beta");
};
CHECKED["GET /store/items"] = async () => {
  const r = await playerCall(BETA, beta().used.externalId, "GET", "/store/items");
  expect(r.status).toBe(200);
  expect(r.json.length, "beta's store is empty: the check would prove nothing").toBeGreaterThan(0);
  noAlphaIds(r.text, "GET /store/items");
};
CHECKED["POST /store/redemptions"] = async () => {
  const before = await snapshot(ALPHA);
  const p = beta().fresh;
  const r = await playerCall(BETA, p.externalId, "POST", "/store/redemptions", { itemId: alpha().itemId });
  expect(r.status, "alpha's store item bought by a beta player").toBe(404);
  await untouched(ALPHA, before, "a redemption of alpha's item by a beta player");
  const own = await playerCall(BETA, p.externalId, "POST", "/store/redemptions", { itemId: beta().itemId });
  expect(own.status, "beta's own item").toBe(201);
};
CHECKED["GET /store/redemptions/:id"] = async () => {
  const p = beta().used;
  const mine = await playerCall(BETA, p.externalId, "GET", `/store/redemptions/${p.redemptionId}`);
  expect(mine.status).toBe(200);
  noAlphaIds(mine.text, "GET /store/redemptions/:id");
  const theirs = await playerCall(
    BETA,
    p.externalId,
    "GET",
    `/store/redemptions/${alpha().used.redemptionId}`,
  );
  expect(theirs.status, "alpha's redemption id").toBe(404);
  // Another player of the same tenant is refused too.
  const sibling = await playerCall(
    BETA,
    p.externalId,
    "GET",
    `/store/redemptions/${(beta().stuck[0] as { id: string }).id}`,
  );
  expect(sibling.status, "another player's redemption").toBe(404);
};
CHECKED["GET /wheel"] = async () => {
  const r = await playerCall(BETA, beta().used.externalId, "GET", "/wheel");
  expect(r.status).toBe(200);
  const newest = (
    await query("SELECT max(version)::int AS v FROM wheel_configs WHERE tenant_id = $1", [BETA])
  ).rows[0].v;
  expect(r.json.version).toBe(newest);
  expect(r.json.segments.length).toBeGreaterThan(0);
  noAlphaIds(r.text, "GET /wheel");
};
CHECKED["POST /wheel/spins/:spinId/spin"] = async () => {
  const before = await snapshot(ALPHA);
  const theirs = alpha().fresh.spinIds[0] as string;
  const r = await playerCall(BETA, beta().fresh.externalId, "POST", `/wheel/spins/${theirs}/spin`);
  expect(r.status, "alpha's spin used by a beta player").toBe(404);
  await untouched(ALPHA, before, "a spin of alpha's by a beta player");
  const own = await playerCall(
    BETA,
    beta().fresh.externalId,
    "POST",
    `/wheel/spins/${beta().fresh.spinIds[0]}/spin`,
  );
  expect(own.status, "beta's own spin").toBe(200);
};

// -- Inbound casino calls: the tenant comes from the path, the signature from that tenant's secret
const alphaSecret = () => tenantOf(ALPHA).webhookSecret;
const betaSecret = () => tenantOf(BETA).webhookSecret;
const post = async (path: string, body: string, headers: Record<string, string>) =>
  answer(await fetch(`${app().url}${path}`, { method: "POST", headers, body }));
const countWhere = async (table: string, tenantId: string, column: string, value: string) =>
  (
    await query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${column} = $2`, [
      tenantId,
      value,
    ])
  ).rows[0].n as number;

CHECKED["POST /webhooks/:tenantId/events"] = async () => {
  // Signed with beta's secret, addressed to alpha: refused, creates nothing.
  const eventA = `evt-${randomUUID()}`;
  let before = await snapshot(ALPHA, ["audit_log"]);
  let audit = await lastAuditId();
  let body = alphaDeposit(eventA, `x-${randomUUID()}`);
  let r = await post(`/webhooks/${ALPHA}/events`, body, signAlpha(betaSecret(), body, now()));
  expect(r.status, "beta's secret on alpha's path").toBe(401);
  await onlyRejectionsAdded(ALPHA, before, audit, "an event signed with beta's secret");
  // Signed with alpha's secret, addressed to beta (platform B wants its own header): refused.
  before = await snapshot(BETA, ["audit_log"]);
  audit = await lastAuditId();
  body = alphaDeposit(eventA, `x-${randomUUID()}`);
  r = await post(`/webhooks/${BETA}/events`, body, signAlpha(alphaSecret(), body, now()));
  expect(r.status, "alpha's event on beta's path").toBe(401);
  const betaBody = JSON.stringify({ transactions: [betaTxn(`T-${randomUUID()}`, `x-${randomUUID()}`)] });
  r = await post(`/webhooks/${BETA}/events`, betaBody, signBeta(alphaSecret(), betaBody));
  expect(r.status, "alpha's secret on beta's path").toBe(401);
  await onlyRejectionsAdded(BETA, before, audit, "an event signed with alpha's secret");
  expect(await countWhere("inbound_events", ALPHA, "external_event_id", eventA)).toBe(0);
  expect(await countWhere("inbound_events", BETA, "external_event_id", eventA)).toBe(0);

  // A correct beta event naming a player that exists in alpha: a new beta player, alpha untouched.
  const shared = alpha().used.externalId;
  const alphaBefore = await snapshot(ALPHA);
  const txn = `T-${randomUUID()}`;
  const good = JSON.stringify({ transactions: [betaTxn(txn, shared)] });
  r = await post(`/webhooks/${BETA}/events`, good, signBeta(betaSecret(), good));
  expect(r.status).toBe(200);
  expect(r.json.accepted).toBe(1);
  await untouched(ALPHA, alphaBefore, "a signed beta event that names alpha's player");
  const inBeta = await query("SELECT id FROM players WHERE tenant_id = $1 AND external_id = $2", [
    BETA,
    shared,
  ]);
  expect(inBeta.rows).toHaveLength(1);
  expect(inBeta.rows[0].id).not.toBe(alpha().used.id);

  // The other way round: a correct alpha event naming a beta player.
  const betaBefore = await snapshot(BETA);
  const sharedB = beta().used.externalId;
  body = alphaDeposit(`evt-${randomUUID()}`, sharedB);
  r = await post(`/webhooks/${ALPHA}/events`, body, signAlpha(alphaSecret(), body, now()));
  expect(r.status).toBe(200);
  await untouched(BETA, betaBefore, "a signed alpha event that names beta's player");
  expect(await countWhere("players", ALPHA, "external_id", sharedB)).toBe(1);
};

CHECKED["POST /webhooks/:tenantId/rewards"] = async () => {
  const notice = (redemptionId: string) =>
    JSON.stringify({ requestId: `r_${randomUUID()}`, externalRef: redemptionId, state: "GRANTED" });
  const theirs = (alpha().stuck[0] as { id: string }).id;
  // Beta's secret, beta's path, alpha's redemption id: not a redemption of this tenant.
  let before = await snapshot(ALPHA);
  let body = notice(theirs);
  let r = await post(`/webhooks/${BETA}/rewards`, body, signBeta(betaSecret(), body));
  expect(r.status, "alpha's redemption named in a beta notice").toBe(404);
  await untouched(ALPHA, before, "a beta notice about alpha's redemption");
  // Beta's secret on alpha's path: refused, nothing changes except the audit of the rejection.
  before = await snapshot(ALPHA, ["audit_log"]);
  const audit = await lastAuditId();
  r = await post(`/webhooks/${ALPHA}/rewards`, body, signBeta(betaSecret(), body));
  expect([400, 401], "beta's secret on alpha's reward path").toContain(r.status);
  await onlyRejectionsAdded(ALPHA, before, audit, "a notice signed with beta's secret");
  const row = await query("SELECT status FROM redemptions WHERE id = $1", [theirs]);
  expect(row.rows[0].status).toBe("submitting");
  // The same notice for beta's own redemption works.
  const own = (beta().stuck[2] as { id: string }).id;
  body = notice(own);
  r = await post(`/webhooks/${BETA}/rewards`, body, signBeta(betaSecret(), body));
  expect(r.status, "beta's own notice").toBe(200);
  expect(r.json).toMatchObject({ redemptionId: own, status: "issued" });
};

// ---------------------------------------------------------------------------------------------
// Setup and tests
// ---------------------------------------------------------------------------------------------

beforeAll(async () => {
  if (!running || !fake) return;
  await seedDemo(running.db, running.clock, fake.url);
  worlds[ALPHA] = await build(ALPHA, ALPHA_MANAGER);
  worlds[BETA] = await build(BETA, BETA_MANAGER);
  // Past the stuck limit (300 s), so the stuck list and the alerts have something to show.
  running.clock.advance(301_000);
  tables = await discoverTables();
  alphaIds = await collectIds(ALPHA);
  console.info(
    `tenant isolation: tables with tenant_id: ${tables.map((t) => t.table).join(", ")}; ${alphaIds.length} alpha identifiers`,
  );
}, 120_000);

afterAll(async () => {
  await fake?.close();
  await running?.close();
});

describe.skipIf(!running)("tenant isolation, per route", () => {
  test("every route has a decision, and every list entry is a live route", () => {
    const live = liveRoutes();
    const problems: string[] = [];
    for (const route of live) {
      const c = route in CHECKED;
      const s = route in SKIPPED;
      if (c && s) problems.push(`Route ${route} is in both CHECKED and SKIPPED.`);
      if (!c && !s) {
        problems.push(
          `New route ${route}: decide — add it to CHECKED with a check, or to SKIPPED with a reason.`,
        );
      }
    }
    for (const route of [...Object.keys(CHECKED), ...Object.keys(SKIPPED)]) {
      if (!live.includes(route))
        problems.push(`Stale entry ${route}: no live route matches it. Remove or rename it.`);
    }
    expect(problems).toEqual([]);
  });

  test("the data and the identifier list are not empty", () => {
    expect(tables.map((t) => t.table)).toEqual(
      expect.arrayContaining(["players", "spins", "redemptions", "audit_log"]),
    );
    for (const t of tables) expect(t.pk.length, `${t.table} has a primary key`).toBeGreaterThan(0);
    expect(alphaIds.length).toBeGreaterThan(30);
    expect(new Set(alphaIds.map((i) => i.source)).size).toBeGreaterThan(8);
  });

  describe("checked routes", () => {
    for (const route of Object.keys(CHECKED)) {
      test(route, async () => {
        await (CHECKED[route] as Check)();
      }, 60_000);
    }
  });
});
