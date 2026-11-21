// A development aid, not part of the product: a mock of our API and of the fake casino, built from
// docs/contracts.md, so the screens can be driven without the real stack. It also serves web/dist at /app/.
// Run: npm run build --prefix web && node web/dev/mock-server.mjs   (PORT, default 4800)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4800);
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PASSWORD = "mock-password";

const rnd = (() => {
  let a = 12345;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const uuid = () => {
  const h = () => Math.floor(rnd() * 0x10000).toString(16).padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
};
let auditSeq = 700;
let outboxSeq = 100;
const now = () => new Date().toISOString();
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();

const TENANTS = [
  { id: "alpha-casino", name: "Alpha Casino", platform: "A" },
  { id: "beta-casino", name: "Beta Casino", platform: "B" },
];
const USERS = [
  { id: "u-ops", email: "ops@demo.local", name: "Platform ops", role: "platform_admin", tenantId: null },
  { id: "u-alpha-m", email: "manager@alpha.demo", name: "Alpha manager", role: "tenant_admin", tenantId: "alpha-casino" },
  { id: "u-alpha-v", email: "viewer@alpha.demo", name: "Alpha viewer", role: "tenant_viewer", tenantId: "alpha-casino" },
  { id: "u-beta-m", email: "manager@beta.demo", name: "Beta manager", role: "tenant_admin", tenantId: "beta-casino" },
];

const WHEEL_V1 = [
  { label: "10 coins", coins: 10, weight: 50 },
  { label: "50 coins", coins: 50, weight: 30 },
  { label: "100 coins", coins: 100, weight: 15 },
  { label: "500 coins", coins: 500, weight: 5 },
];
const expected = (segs) => {
  const w = segs.reduce((a, s) => a + s.weight, 0);
  return Math.round((segs.reduce((a, s) => a + s.coins * s.weight, 0) * 100) / w) / 100;
};

const ITEMS = [
  { id: "item-5", code: "bonus-5-eur", name: "Bonus 5 EUR", costCoins: "500", reward: { type: "bonus", currency: "EUR", amountMinor: 500 }, active: true },
  { id: "item-1", code: "bonus-1-eur", name: "Bonus 1 EUR", costCoins: "100", reward: { type: "bonus", currency: "EUR", amountMinor: 100 }, active: true },
];

// ---- state per tenant ----
const db = {};
function seedTenant(t, scale) {
  const s = {
    players: [], events: [], spins: [], redemptions: [], outbox: [], audit: [],
    wheel: [{ id: uuid(), version: 1, createdAt: ago(86400 * 5), segments: WHEEL_V1 }],
    grant: [{ id: uuid(), version: 1, createdAt: ago(86400 * 5), params: { minAmountMinor: 1, currencies: null, spinsPerDeposit: 1 } }],
    ops: [{ id: uuid(), version: 1, createdAt: ago(86400 * 5), params: { pendingAgeLimitSec: 300, maxExpectedPrizeCoins: 100, maxSpinsPerPlayerPerDay: 20, maxPlayerRedeemShare: 0.5, minRedeemedForShare: 1000 } }],
    changes: [],
    live: new Map(), // player external id -> live game state
  };
  db[t.id] = s;
  for (let i = 0; i < scale; i++) {
    const ext = `${t.platform === "A" ? "p" : "77"}${100 + i}`;
    const p = { id: uuid(), externalId: ext, createdAt: ago(86400 * 3 - i * 600) };
    s.players.push(p);
    const evId = uuid();
    const ev = {
      id: evId, externalEventId: `evt_${1000 + i}`, kind: "deposit_succeeded", playerId: p.id, playerExternalId: ext,
      receivedAt: ago(7200 - i * 40),
      normalized: { kind: "deposit_succeeded", externalEventId: `evt_${1000 + i}`, externalPlayerId: ext, amountMinor: 2000, currency: "EUR", occurredAt: ago(7200 - i * 40) },
      raw: t.platform === "A"
        ? { event_id: `evt_${1000 + i}`, type: "deposit.succeeded", player_id: ext, amount_minor: 2000, currency: "EUR", occurred_at: ago(7200 - i * 40) }
        : { batchId: `batch-${i}`, transactions: [{ txnId: `evt_${1000 + i}`, kind: "DEPOSIT", state: "COMPLETED", customer: { id: ext }, amount: "20.00", currencyCode: "EUR" }] },
    };
    s.events.push(ev);
    const coins = [10, 50, 10, 100, 10, 50, 500][i % 7];
    const used = i % 5 !== 0;
    const sp = {
      id: uuid(), playerId: p.id, playerExternalId: ext, status: used ? "used" : "available", coins: used ? String(coins) : null,
      segmentIndex: used ? [0, 1, 0, 2, 0, 1, 3][i % 7] : null, createdAt: ev.receivedAt, usedAt: used ? ago(7000 - i * 40) : null,
      creditedAt: used ? ago(6990 - i * 40) : null, wheelVersion: 1, grantPolicyVersion: 1, eventId: evId,
    };
    s.spins.push(sp);
    if (used && i % 3 === 0) {
      const status = ["issued", "issued", "refused"][i % 3 === 0 ? (i / 3) % 3 : 0];
      const r = {
        id: uuid(), createdAt: ago(5000 - i * 30), updatedAt: ago(4990 - i * 30), playerId: p.id, playerExternalId: ext,
        itemCode: "bonus-1-eur", itemName: "Bonus 1 EUR", costCoins: "100", status, settled: true,
        platformRef: status === "issued" ? `b_${i}` : null, reason: status === "refused" ? "player_blocked" : null,
      };
      s.redemptions.push(r);
      s.audit.push(
        { id: ++auditSeq, at: r.createdAt, actor: `player/${p.id}`, actorEmail: null, action: "create", entityType: "redemptions", entityId: r.id, changes: [{ field: "status", from: null, to: "created" }, { field: "cost_coins", from: null, to: "100" }], requestId: `req-${i}a` },
        { id: ++auditSeq, at: r.updatedAt, actor: `system/outbox`, actorEmail: null, action: "update", entityType: "redemptions", entityId: r.id, changes: [{ field: "status", from: "submitting", to: status }], requestId: `req-${i}b` },
      );
    }
  }
  s.events.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  s.spins.reverse(); s.players.reverse(); s.redemptions.reverse();
  s.audit.sort((a, b) => (a.at < b.at ? 1 : -1));
}
seedTenant(TENANTS[0], 130);
seedTenant(TENANTS[1], 24);

// A stuck redemption and some trouble for alpha.
{
  const s = db["alpha-casino"];
  s.job = {};
  for (const [n, age] of [[0, 2400], [3, 900]]) {
    const p = s.players[n];
    const r = {
      id: uuid(), createdAt: ago(age), updatedAt: ago(age - 100), playerId: p.id, playerExternalId: p.externalId, itemCode: "bonus-5-eur",
      itemName: "Bonus 5 EUR", costCoins: "500", status: "submitting", settled: false, platformRef: null, reason: null,
    };
    s.redemptions.unshift(r);
    s.job[r.id] = { runAt: ago(-30), attempts: 7, lastError: "PlatformUnreachable: timeout after 2000 ms", doneAt: null, deadAt: null };
    s.audit.unshift(
      { id: ++auditSeq, at: ago(age - 100), actor: "system/outbox", actorEmail: null, action: "platform_call", entityType: "redemption", entityId: r.id, changes: { call: "find", error: "find: unexpected answer, status 500" }, requestId: `job:redemption_advance:${r.id}` },
      { id: ++auditSeq, at: ago(age), actor: `player/${p.id}`, actorEmail: null, action: "create", entityType: "redemptions", entityId: r.id, changes: [{ field: "status", from: null, to: "created" }], requestId: "req-stuck" },
    );
  }
  s.events.unshift({
    id: uuid(), externalEventId: "evt_ign_1", kind: "ignored", playerId: null, playerExternalId: null, receivedAt: ago(30),
    normalized: { why: "type login.succeeded", kind: "ignored", externalEventId: "evt_ign_1" },
    raw: { event_id: "evt_ign_1", type: "login.succeeded", player_id: "p100", occurred_at: ago(30) },
  });
  s.outbox.push(
    { id: ++outboxSeq, kind: "redemption_advance", refId: s.redemptions[0].id, runAt: ago(-30), attempts: 7, lastError: "PlatformUnreachable: timeout after 2000 ms", doneAt: null, deadAt: null },
    { id: ++outboxSeq, kind: "spin_credit", refId: s.spins[1].id, runAt: ago(60), attempts: 10, lastError: "LedgerUnavailable", doneAt: null, deadAt: ago(30) },
  );
  for (let i = 0; i < 60; i++)
    s.outbox.push({ id: ++outboxSeq, kind: "spin_credit", refId: s.spins[i + 2]?.id ?? uuid(), runAt: ago(9000 - i * 100), attempts: 1, lastError: null, doneAt: ago(8990 - i * 100), deadAt: null });
  s.changes.push({
    id: uuid(), tenantId: "alpha-casino", kind: "wheel_config",
    proposed: { segments: [{ label: "20 coins", coins: 20, weight: 60 }, { label: "300 coins", coins: 300, weight: 40 }] },
    status: "applied", expectedPrizeCoins: 132, limitCoins: 100, proposedBy: "admin/u-alpha-m", proposedByEmail: "manager@alpha.demo", decidedBy: "admin/u-ops", decidedByEmail: "ops@demo.local",
    decisionNote: "Checked with the casino.", resultId: null, createdAt: ago(86400 * 2), decidedAt: ago(86400 * 2 - 600),
  });
}
db["beta-casino"].outbox.push({ id: ++outboxSeq, kind: "spin_credit", refId: uuid(), runAt: ago(5), attempts: 0, lastError: null, doneAt: null, deadAt: null });

// ---- helpers ----
const sessions = new Map(); // admin token -> { user, exp }
const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...extra });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
  });
});

function paged(rows, url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const before = url.searchParams.get("before");
  const start = before ? Number(Buffer.from(before, "base64url").toString().split(":")[1]) + 1 : 0;
  const slice = rows.slice(start, start + limit).map((r, i) => ({ ...r, cursor: Buffer.from(`i:${start + i}`).toString("base64url") }));
  const nextCursor = start + limit < rows.length ? slice.at(-1).cursor : null;
  return { items: slice, nextCursor };
}

const live = (t, ext) => {
  const s = db[t];
  if (!s.live.has(ext)) s.live.set(ext, { ext, spins: [], balance: 0, reserved: 0, reds: [] });
  return s.live.get(ext);
};
let wheelOverride = null;
const currentWheel = (t) => wheelOverride ?? db[t].wheel[0].segments;

function fakeJwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(payload)}.mock`;
}
const player = (req) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (p.exp * 1000 < Date.now()) return null;
    return { tenantId: p.iss, ext: p.sub };
  } catch {
    return null;
  }
};

// ---- the casino and player side ----
async function casino(req, res, url) {
  const path = url.pathname;
  if (path === "/control/config") return json(res, 200, { tenants: TENANTS });
  if (path === "/control/token") {
    const b = await readBody(req);
    return json(res, 200, { token: fakeJwt({ iss: b.tenantId, sub: b.playerId, exp: Math.floor(Date.now() / 1000) + 600 }) });
  }
  if (path === "/control/deposit") {
    const b = await readBody(req);
    const l = live(b.tenantId, b.playerId);
    l.spins.push({ id: uuid(), status: "available", coins: null });
    return json(res, 200, { eventId: `evt_${uuid().slice(0, 6)}`, sent: [{ status: 200, body: { accepted: 1, duplicates: 0, ignored: 0 } }] });
  }
  if (path === "/mock/wheel") {
    const b = await readBody(req);
    wheelOverride = b.n ? Array.from({ length: b.n }, (_, i) => ({ label: i % 3 === 0 ? `${(i + 1) * 10} coins` : i % 3 === 1 ? `${(i + 1) * 5} coins` : `Free bonus ${i + 1}`, coins: (i + 1) * 5 })) : null;
    return json(res, 200, { ok: true });
  }
  const p = player(req);
  if (!p) return json(res, 401, { message: "Unauthorized", statusCode: 401 });
  const l = live(p.tenantId, p.ext);
  if (path === "/me")
    return json(res, 200, { playerId: p.ext, tenantId: p.tenantId, balance: { available: String(l.balance), reserved: String(l.reserved) }, spins: l.spins });
  if (path === "/wheel") return json(res, 200, { version: 1, segments: currentWheel(p.tenantId).map(({ label, coins }) => ({ label, coins })) });
  const m = path.match(/^\/wheel\/spins\/([^/]+)\/spin$/);
  if (m) {
    const sp = l.spins.find((x) => x.id === m[1]);
    if (!sp) return json(res, 404, { message: "Not found" });
    if (sp.status === "available") {
      const segs = currentWheel(p.tenantId);
      const idx = Math.floor(rnd() * segs.length);
      sp.status = "used"; sp.coins = String(segs[idx].coins); sp.idx = idx; sp.label = segs[idx].label;
      l.balance += segs[idx].coins;
    }
    return json(res, 200, { spinId: sp.id, segmentIndex: sp.idx, label: sp.label, coins: Number(sp.coins) });
  }
  if (path === "/store/items") return json(res, 200, ITEMS.map(({ active, ...i }) => i));
  if (path === "/store/redemptions" && req.method === "POST") {
    const b = await readBody(req);
    const item = ITEMS.find((i) => i.id === b.itemId);
    if (!item) return json(res, 404, { message: "Not found" });
    const cost = Number(item.costCoins);
    const r = { id: uuid(), costCoins: item.costCoins, reward: item.reward, reason: null, at: Date.now() };
    if (l.balance < cost) r.status = "insufficient";
    else { l.balance -= cost; l.reserved += cost; r.status = "submitting"; r.cost = cost; }
    l.reds.push(r);
    return json(res, 201, view(r, l));
  }
  const rm = path.match(/^\/store\/redemptions\/([^/]+)$/);
  if (rm) {
    const r = l.reds.find((x) => x.id === rm[1]);
    if (!r) return json(res, 404, { message: "Not found" });
    return json(res, 200, view(r, l));
  }
  return json(res, 404, { message: "Not found" });
}
function view(r, l) {
  if (r.status === "submitting" && Date.now() - r.at > 2500) {
    r.status = "issued";
    l.reserved -= r.cost;
  }
  return { id: r.id, status: r.status, costCoins: r.costCoins, reward: r.reward, reason: r.reason, platformRef: r.status === "issued" ? "b_live" : null, settled: r.status === "issued" };
}

// ---- admin side ----
function adminUser(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) return null;
  return s.user;
}
const redactAudit = (a) => a;

function alertsFor(t) {
  const s = db[t];
  const alerts = [];
  const stuck = s.redemptions.filter((r) => ["submitting", "created", "reserved"].includes(r.status) && Date.now() - Date.parse(r.createdAt) > 300000);
  for (const r of stuck)
    alerts.push({ code: "redemption_pending_too_long", severity: "critical", subject: r.id, value: Math.round((Date.now() - Date.parse(r.createdAt)) / 1000), limit: 300, detail: { status: r.status, playerExternalId: r.playerExternalId } });
  const dead = s.outbox.filter((o) => o.deadAt).length;
  if (dead) alerts.push({ code: "outbox_dead_jobs", severity: "critical", subject: "outbox", value: dead, limit: 0, detail: { kinds: ["spin_credit"] } });
  const e = expected(currentWheel(t));
  if (e > s.ops[0].params.maxExpectedPrizeCoins)
    alerts.push({ code: "wheel_expected_prize_high", severity: "warning", subject: `wheel v${s.wheel[0].version}`, value: e, limit: s.ops[0].params.maxExpectedPrizeCoins, detail: {} });
  return alerts;
}

function applyWheel(t, change, by, note) {
  const s = db[t];
  const row = { id: uuid(), version: s.wheel[0].version + 1, createdAt: now(), segments: change.proposed.segments };
  s.wheel.unshift(row);
  change.status = "applied"; change.decidedBy = by; change.decidedByEmail = by.startsWith("admin/") ? USERS.find((x) => `admin/${x.id}` === by)?.email ?? null : null; change.decisionNote = note; change.resultId = row.id; change.decidedAt = now();
  return row;
}

async function admin(req, res, url) {
  const path = url.pathname;
  if (path === "/admin/auth/login" && req.method === "POST") {
    const b = await readBody(req);
    const u = USERS.find((x) => x.email === String(b.email).toLowerCase());
    if (!u || b.password !== PASSWORD) return json(res, 401, { message: "Unauthorized", statusCode: 401 });
    const token = `mock-${uuid()}`;
    const exp = Date.now() + (Number(process.env.SESSION_MS) || 30 * 60000);
    sessions.set(token, { user: u, exp });
    return json(res, 200, { token, expiresAt: new Date(exp).toISOString(), user: u });
  }
  const u = adminUser(req);
  if (!u) return json(res, 401, { message: "Unauthorized", statusCode: 401 });
  if (path === "/admin/auth/me") return json(res, 200, u);
  if (path === "/platform/tenants") return json(res, 200, u.role === "platform_admin" ? TENANTS : TENANTS.filter((t) => t.id === u.tenantId));
  if (path === "/platform/settings-changes" && req.method === "GET") {
    if (u.role !== "platform_admin") return json(res, 403, { message: "Forbidden" });
    const status = url.searchParams.get("status");
    const all = Object.values(db).flatMap((s) => s.changes).filter((c) => !status || c.status === status).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return json(res, 200, all);
  }
  const dec = path.match(/^\/platform\/settings-changes\/([^/]+)\/(approve|reject)$/);
  if (dec && req.method === "POST") {
    if (u.role !== "platform_admin") return json(res, 403, { message: "Forbidden" });
    const b = await readBody(req);
    if (typeof b.note !== "string" || b.note.length < 5 || b.note.length > 500) return json(res, 400, { message: "note needs 5..500 characters" });
    for (const [t, s] of Object.entries(db)) {
      const c = s.changes.find((x) => x.id === dec[1]);
      if (!c) continue;
      if (c.status !== "proposed") return json(res, 409, { message: "Change is not waiting" });
      if (dec[2] === "approve") applyWheel(t, c, `admin/${u.id}`, b.note);
      else { c.status = "rejected"; c.decidedBy = `admin/${u.id}`; c.decidedByEmail = u.email; c.decisionNote = b.note; c.decidedAt = now(); }
      return json(res, 200, dec[2] === "approve" ? { change: c, wheelVersion: s.wheel[0].version } : { change: c });
    }
    return json(res, 404, { message: "Not found" });
  }
  const m = path.match(/^\/admin\/([^/]+)\/(.+)$/);
  if (!m) return json(res, 404, { message: "Not found" });
  const [, t, rest] = m;
  if (!db[t] || (u.role !== "platform_admin" && u.tenantId !== t)) return json(res, 404, { message: "Not found" });
  const s = db[t];
  const q = (k) => url.searchParams.get(k);

  if (rest === "overview") {
    const count = (st) => s.redemptions.filter((r) => r.status === st).length;
    const al = alertsFor(t);
    return json(res, 200, {
      at: now(), players: s.players.length, events24h: { accepted: s.events.filter((e) => e.kind !== "ignored").length, ignored: s.events.filter((e) => e.kind === "ignored").length },
      spins: { available: s.spins.filter((x) => x.status === "available").length, used: s.spins.filter((x) => x.status === "used").length },
      redemptions: { created: count("created"), reserved: count("reserved"), submitting: count("submitting"), issued: count("issued"), refused: count("refused"), insufficient: count("insufficient"), unsettled: s.redemptions.filter((r) => !r.settled).length },
      coinsOutstanding: t === "beta-casino" ? null : "48210",
      outbox: { due: s.outbox.filter((o) => !o.doneAt && !o.deadAt && Date.parse(o.runAt) <= Date.now()).length, waiting: s.outbox.filter((o) => !o.doneAt && !o.deadAt && Date.parse(o.runAt) > Date.now()).length, dead: s.outbox.filter((o) => o.deadAt).length },
      alerts: { critical: al.filter((a) => a.severity === "critical").length, warning: al.filter((a) => a.severity === "warning").length },
      settings: { wheelVersion: s.wheel[0].version, grantPolicyVersion: 1, opsPolicyVersion: 1 },
    });
  }
  if (rest === "alerts") return json(res, 200, { at: now(), policyVersion: 1, alerts: alertsFor(t) });
  if (rest === "redemptions/stuck") {
    const items = s.redemptions.filter((r) => ["created", "reserved", "submitting"].includes(r.status) || !r.settled)
      .filter((r) => Date.now() - Date.parse(r.createdAt) > 300000)
      .map((r) => ({ id: r.id, status: r.status, settled: r.settled, playerExternalId: r.playerExternalId, costCoins: r.costCoins, ageSec: Math.round((Date.now() - Date.parse(r.createdAt)) / 1000), platformRef: r.platformRef, lastPlatformCall: r.status === "submitting" ? { call: "find", error: "find: unexpected answer, status 500" } : null }));
    return json(res, 200, { limitSec: 300, items });
  }
  if (rest === "redemptions") {
    const rows = s.redemptions.filter((r) => (!q("status") || r.status === q("status")) && (!q("playerId") || r.playerId === q("playerId") || r.playerExternalId === q("playerId")));
    return json(res, 200, paged(rows, url));
  }
  let mm;
  if ((mm = rest.match(/^redemptions\/([^/]+)\/resolve$/)) && req.method === "POST") {
    if (u.role === "tenant_viewer") return json(res, 403, { message: "Forbidden" });
    const r = s.redemptions.find((x) => x.id === mm[1]);
    if (!r) return json(res, 404, { message: "Not found" });
    const b = await readBody(req);
    if (!["issued", "refused"].includes(b.outcome) || typeof b.note !== "string" || b.note.length < 5 || b.note.length > 500) return json(res, 400, { message: "bad outcome or note" });
    if (r.status !== "submitting") return json(res, 409, { message: "only a submitting redemption can be resolved", view: { id: r.id, status: r.status } });
    r.status = b.outcome; r.updatedAt = now(); r.settled = true; r.platformRef = b.outcome === "issued" ? "manual" : null; r.reason = b.outcome === "refused" ? `manual: ${b.note}` : null;
    s.audit.unshift({ id: ++auditSeq, at: now(), actor: `admin/${u.id}`, actorEmail: u.email, action: "manual_resolution", entityType: "redemption", entityId: r.id, changes: { outcome: b.outcome, note: b.note }, requestId: "req-resolve" });
    if (s.job?.[r.id]) s.job[r.id].doneAt = now();
    return json(res, 200, { id: r.id, status: r.status, costCoins: r.costCoins, reward: { type: "bonus", currency: "EUR", amountMinor: r.itemCode === "bonus-5-eur" ? 500 : 100 }, reason: r.reason, platformRef: r.platformRef, settled: r.settled });
  }
  if ((mm = rest.match(/^redemptions\/([^/]+)$/))) {
    const r = s.redemptions.find((x) => x.id === mm[1]);
    if (!r) return json(res, 404, { message: "Not found" });
    return json(res, 200, { redemption: r, reward: { type: "bonus", currency: "EUR", amountMinor: r.itemCode === "bonus-5-eur" ? 500 : 100 }, audit: s.audit.filter((a) => a.entityId === r.id).sort((a, b) => (a.at < b.at ? -1 : 1)), job: s.job?.[r.id] ?? null });
  }
  if (rest === "players") {
    const rows = s.players.filter((p) => !q("q") || p.externalId.startsWith(q("q"))).map((p) => ({ ...p, spinsAvailable: s.spins.filter((x) => x.playerId === p.id && x.status === "available").length, spinsUsed: s.spins.filter((x) => x.playerId === p.id && x.status === "used").length, redemptions: s.redemptions.filter((x) => x.playerId === p.id).length }));
    return json(res, 200, paged(rows, url));
  }
  if ((mm = rest.match(/^players\/([^/]+)$/))) {
    const p = s.players.find((x) => x.id === mm[1]);
    if (!p) return json(res, 404, { message: "Not found" });
    return json(res, 200, { player: p, balance: t === "beta-casino" ? null : { available: "150", reserved: "0" }, spins: s.spins.filter((x) => x.playerId === p.id), redemptions: s.redemptions.filter((x) => x.playerId === p.id), events: s.events.filter((x) => x.playerId === p.id).map(({ raw, ...e }) => e) });
  }
  if (rest === "events" && q("kind") && !["deposit_succeeded", "ignored"].includes(q("kind"))) return json(res, 400, { message: "kind must be one of deposit_succeeded, ignored", error: "Bad Request", statusCode: 400 });
  if (rest === "events") return json(res, 200, paged(s.events.filter((e) => !q("kind") || e.kind === q("kind")).map(({ raw, ...e }) => e), url));
  if ((mm = rest.match(/^events\/([^/]+)$/))) {
    const e = s.events.find((x) => x.id === mm[1]);
    if (!e) return json(res, 404, { message: "Not found" });
    return json(res, 200, { ...e, spins: s.spins.filter((x) => x.eventId === e.id).map((x) => ({ id: x.id, status: x.status })) });
  }
  if (rest === "spins") return json(res, 200, paged(s.spins.filter((x) => (!q("status") || x.status === q("status")) && (!q("playerId") || x.playerId === q("playerId"))), url));
  if (rest === "outbox") {
    const st = q("state");
    const f = { due: (o) => !o.doneAt && !o.deadAt && Date.parse(o.runAt) <= Date.now(), waiting: (o) => !o.doneAt && !o.deadAt && Date.parse(o.runAt) > Date.now(), dead: (o) => !!o.deadAt, done: (o) => !!o.doneAt };
    return json(res, 200, paged(s.outbox.filter((o) => !st || f[st]?.(o)), url));
  }
  if (rest === "audit") {
    if (q("entityId")) return json(res, 200, s.audit.filter((a) => a.entityId === q("entityId")).sort((a, b) => (a.at < b.at ? -1 : 1)));
    if (!q("recent")) return json(res, 400, { message: "entityId required" });
    return json(res, 200, paged(s.audit.filter((a) => (!q("action") || a.action === q("action")) && (!q("actor") || a.actor.startsWith(q("actor")))).map(redactAudit), url));
  }
  if (rest === "settings")
    return json(res, 200, {
      wheel: s.wheel.map((w) => ({ ...w, expectedPrizeCoins: expected(w.segments) })), grantPolicies: s.grant, opsPolicies: s.ops, storeItems: ITEMS,
      changes: [...s.changes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    });
  if (rest === "settings/wheel" && req.method === "POST") {
    if (u.role === "tenant_viewer") return json(res, 403, { message: "Forbidden" });
    const b = await readBody(req);
    const segs = b.segments;
    const ok = Array.isArray(segs) && segs.length >= 2 && segs.length <= 24 && segs.every((x) => typeof x.label === "string" && x.label.length >= 1 && x.label.length <= 40 && Number.isInteger(x.coins) && x.coins >= 1 && Number.isInteger(x.weight) && x.weight >= 1);
    if (!ok) return json(res, 400, { message: "invalid segments" });
    const e = expected(segs);
    const limit = s.ops[0].params.maxExpectedPrizeCoins;
    const change = { id: uuid(), tenantId: t, kind: "wheel_config", proposed: { segments: segs }, status: "proposed", expectedPrizeCoins: e, limitCoins: limit, proposedBy: `admin/${u.id}`, proposedByEmail: u.email, decidedBy: null, decidedByEmail: null, decisionNote: null, resultId: null, createdAt: now(), decidedAt: null };
    s.changes.push(change);
    if (e <= limit) {
      const row = applyWheel(t, change, "policy/ops-v1", "Within the limit");
      return json(res, 201, { change, wheelVersion: row.version });
    }
    return json(res, 202, { change });
  }
  return json(res, 404, { message: "Not found" });
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return json(res, 204, undefined, { "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
  try {
    if (url.pathname === "/app-config.json")
      return json(res, 200, {
        fakeCasinoUrl: `http://localhost:${PORT}`,
        ...(process.env.NO_DEMO ? {} : { demoAdmins: USERS.map((x) => ({ email: x.email, password: PASSWORD, role: x.role, tenantId: x.tenantId })) }),
      });
    if (url.pathname.startsWith("/app")) {
      const file = url.pathname === "/app" || url.pathname === "/app/" ? "index.html" : url.pathname.slice(5);
      const body = await readFile(join(DIST, file)).catch(() => null);
      if (!body) return json(res, 404, { message: "Not found" });
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(body);
    }
    if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/platform")) return await admin(req, res, url);
    return await casino(req, res, url);
  } catch (err) {
    console.error(err);
    return json(res, 500, { message: String(err) });
  }
});
server.listen(PORT, () => console.log(`mock on http://localhost:${PORT}/app/  (password ${PASSWORD})`));
