import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { FakeClock } from "../src/clock.ts";
import { transaction } from "../src/db.ts";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { type Level, Log, MemorySink, withRequestId } from "../src/logging/log.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { demoOpsPolicy, demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { alphaDeposit, betaTxn, signAlpha, signBeta, tokenFor } from "./signing.ts";

// Unit tests of Log need nothing else. The tests of the running service are further down and are
// skipped when no TigerBeetle is available.

function makeLog(level: (tenantId: string | null) => Level = () => "info") {
  const sink = new MemorySink();
  const log = new Log(sink, new FakeClock("2026-03-04T05:06:07Z"), level);
  const parsed = () => sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { sink, log, parsed };
}

describe("Log", () => {
  test("a line has at, level, event, tenantId, requestId and the fields", () => {
    const { log, parsed } = makeLog();
    log.event("info", "x.happened", { tenantId: "t1", requestId: "r1", n: 3 });
    expect(parsed()).toEqual([
      {
        at: "2026-03-04T05:06:07.000Z",
        level: "info",
        event: "x.happened",
        tenantId: "t1",
        requestId: "r1",
        n: 3,
      },
    ]);
  });

  test("the level of the tenant decides: debug is dropped at info, kept at debug; errors always pass", () => {
    const { log, parsed } = makeLog((t) => (t === "loud" ? "debug" : "info"));
    for (const t of ["loud", "quiet", null]) {
      log.event("debug", "d", { tenantId: t });
      log.event("info", "i", { tenantId: t });
      log.event("warn", "w", { tenantId: t });
      log.event("error", "e", { tenantId: t });
    }
    const seen = parsed().map((l) => `${String(l.tenantId)}:${String(l.event)}`);
    expect(seen).toEqual([
      "loud:d",
      "loud:i",
      "loud:w",
      "loud:e",
      "quiet:i",
      "quiet:w",
      "quiet:e",
      "null:i",
      "null:w",
      "null:e",
    ]);
  });

  test("a level that only lets errors through is respected too", () => {
    const { log, parsed } = makeLog(() => "error");
    log.event("warn", "w");
    log.event("error", "e");
    expect(parsed().map((l) => l.event)).toEqual(["e"]);
  });

  test("secret-looking keys are written as *** at every depth, in arrays too", () => {
    const { sink, log } = makeLog();
    log.event("info", "x", {
      tenantId: "t",
      idempotencyKey: "KEY-1",
      nested: {
        webhookSecret: "S1",
        deep: [{ authorization: "Bearer abc.def" }, { password: "P1" }],
        ok: "fine",
      },
      signature: "SIG1",
      apiToken: "T1",
    });
    const line = sink.lines[0] as string;
    for (const secret of ["KEY-1", "S1", "abc.def", "P1", "SIG1", "T1"]) expect(line).not.toContain(secret);
    const o = JSON.parse(line);
    expect(o.nested.ok).toBe("fine");
    expect(o.idempotencyKey).toBe("***");
    expect(o.nested.deep[0].authorization).toBe("***");
  });

  test("a bearer token inside a text value is cut out", () => {
    const { sink, log } = makeLog();
    log.event("warn", "x", { error: "call failed with Authorization: Bearer abc.def.ghi, retrying" });
    expect(sink.lines[0]).not.toContain("abc.def.ghi");
    expect(sink.lines[0]).toContain("Bearer ***");
  });

  test("bigint is written as a string", () => {
    const { log, parsed } = makeLog();
    log.event("info", "x", { coins: 12345678901234567890n, list: [1n] });
    expect(parsed()[0]).toMatchObject({ coins: "12345678901234567890", list: ["1"] });
  });

  test("a value that cannot be serialised does not throw; a minimal line says so", () => {
    const { log, parsed } = makeLog();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => log.event("info", "x", { tenantId: "t", loop })).not.toThrow();
    expect(parsed()).toEqual([
      {
        at: "2026-03-04T05:06:07.000Z",
        level: "info",
        event: "x",
        tenantId: "t",
        requestId: null,
        logError: "fields not serialisable",
      },
    ]);
  });

  test("a sink or a level function that throws does not throw out of event", () => {
    const clock = new FakeClock();
    const bad = new Log(
      {
        write: () => {
          throw new Error("disk full");
        },
      },
      clock,
      () => "info",
    );
    expect(() => bad.event("info", "x")).not.toThrow();
    const bad2 = new Log(new MemorySink(), clock, () => {
      throw new Error("no level");
    });
    expect(() => bad2.event("info", "x")).not.toThrow();
  });

  test("a line is exactly one line: a newline inside a string is escaped", () => {
    const { sink, log } = makeLog();
    log.event("warn", "x", { error: "first\nsecond\r\nthird", "odd\nkey": 1 });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toMatch(/[\r\n]/);
    expect(JSON.parse(sink.lines[0] as string).error).toBe("first\nsecond\r\nthird");
  });

  test("the request id comes from the running request when the caller gives none", () => {
    const { log, parsed } = makeLog();
    withRequestId("req-9", () => log.event("info", "a"));
    withRequestId("req-9", () => log.event("info", "b", { requestId: "explicit" }));
    log.event("info", "c");
    expect(parsed().map((l) => l.requestId)).toEqual(["req-9", "explicit", null]);
  });
});

const running = await startApp();
afterAll(async () => {
  await running?.close();
});
const app = () => {
  if (!running) throw new Error("no app");
  return running;
};

describe.skipIf(!running)("request id", () => {
  beforeAll(() => {
    app().logs.length = 0;
  });

  test("a valid x-request-id is echoed", async () => {
    const r = await fetch(`${app().url}/health`, { headers: { "x-request-id": "abc.DEF_12-3" } });
    expect(r.headers.get("x-request-id")).toBe("abc.DEF_12-3");
  });

  test("an invalid x-request-id is replaced by a uuid; a missing one gets a uuid", async () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const bad of ["has space", "x".repeat(65), "semi;colon", "line\tbreak"]) {
      const r = await fetch(`${app().url}/health`, { headers: { "x-request-id": bad } });
      expect(r.headers.get("x-request-id")).toMatch(uuid);
    }
    const none = await fetch(`${app().url}/health`);
    expect(none.headers.get("x-request-id")).toMatch(uuid);
  });
});

// ---- the whole service ----

const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;
const ALPHA = "alpha-casino";
const BETA = "beta-casino";
const tenantOf = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};

beforeAll(async () => {
  if (running && fake) await seedDemo(running.db, running.clock, fake.url);
});
afterAll(async () => {
  await fake?.close();
});

const fakeUrl = () => (fake as FakeCasino).url;
const now = () => app().clock.now().getTime();
const outbox = () => app().app.get<Outbox>(OUTBOX);

type Line = Record<string, unknown>;
const logs = (): Line[] => app().logs;
const clearLogs = () => {
  app().logs.length = 0;
  app().rawLogs.length = 0;
};
const named = (name: string, from: Line[] = logs()) => from.filter((l) => l.event === name);

/** Signatures and tokens the tests sent, so that a test can look for them in the logs. */
const sentSecrets: string[] = [];

async function postDeposit(
  tenantId: string,
  eventId: string,
  externalPlayerId: string,
  options: { extra?: Record<string, unknown>; requestId?: string; secret?: string } = {},
) {
  const t = tenantOf(tenantId);
  const secret = options.secret ?? t.webhookSecret;
  let body: string;
  let headers: Record<string, string>;
  if (t.platform === "A") {
    body = alphaDeposit(eventId, externalPlayerId);
    headers = signAlpha(secret, body, now());
    sentSecrets.push(headers["x-alpha-signature"] as string);
  } else {
    body = JSON.stringify({
      batchId: `b-${eventId}`,
      transactions: [betaTxn(eventId, externalPlayerId, options.extra)],
    });
    headers = signBeta(secret, body);
    sentSecrets.push(headers["x-beta-auth"] as string);
  }
  if (options.requestId) headers["x-request-id"] = options.requestId;
  const r = await fetch(`${app().url}/webhooks/${tenantId}/events`, { method: "POST", headers, body });
  return { status: r.status, requestId: r.headers.get("x-request-id") };
}

/** A signed event of a type the service does not act on (platform A). */
async function postIgnoredAlpha(eventId: string) {
  const body = JSON.stringify({ event_id: eventId, type: "player.login" });
  const headers = signAlpha(tenantOf(ALPHA).webhookSecret, body, now());
  const r = await fetch(`${app().url}/webhooks/${ALPHA}/events`, { method: "POST", headers, body });
  expect(r.status).toBe(200);
}

const bearer = (tenantId: string, externalId: string) => {
  const token = tokenFor(tenantId, tenantOf(tenantId).tokenSecret, externalId, now());
  sentSecrets.push(token);
  return { authorization: `Bearer ${token}` };
};

async function call<T>(tenantId: string, externalId: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`${app().url}${path}`, {
    ...init,
    headers: { ...bearer(tenantId, externalId), "content-type": "application/json", ...init.headers },
  });
  return { status: r.status, json: (await r.json()) as T, requestId: r.headers.get("x-request-id") };
}

interface View {
  id: string;
  status: string;
  settled: boolean;
}

/** Deposit, spin, redeem. The player gets 500 coins from the ledger first so that the redemption can pay. */
async function flow(tenantId: string, tag: string) {
  const externalId = `p-${tag}`;
  await postDeposit(tenantId, `evt-${tag}`, externalId);
  const mine = await call<{ playerId: string; spins: { id: string }[] }>(tenantId, externalId, "/me");
  const spinId = mine.json.spins[0]?.id as string;
  await call(tenantId, externalId, `/wheel/spins/${spinId}/spin`, { method: "POST" });
  const item = (
    await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = 'bonus-1-eur'", [
      tenantId,
    ])
  ).rows[0].id as string;
  await app()
    .app.get<CoinLedger>(COIN_LEDGER)
    .creditPrize({
      ledgerNo: tenantOf(tenantId).ledgerNo,
      playerId: mine.json.playerId,
      spinId: randomUUID(),
      coins: 500n,
    });
  const redeemed = await call<View>(tenantId, externalId, "/store/redemptions", {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ itemId: item }),
  });
  return { externalId, spinId, redemptionId: redeemed.json.id, view: redeemed.json };
}

async function deliver() {
  await fetch(`${fakeUrl()}/control/b/deliver`, { method: "POST" });
}

async function fault(point: string, kind: string, times = 1) {
  const r = await fetch(`${fakeUrl()}/control/faults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ point, fault: kind, times }),
  });
  expect(r.status).toBe(200);
}

async function later(ms: number) {
  app().clock.advance(ms);
  return outbox().runDue();
}

/** Alpha logs at debug from policy version 2. Safe to call twice. Waits until the new level is read. */
async function alphaAtDebug() {
  await app().db.query(
    "INSERT INTO ops_policies (tenant_id, version, params) VALUES ($1, 2, $2) ON CONFLICT DO NOTHING",
    [ALPHA, JSON.stringify({ ...demoOpsPolicy, logLevel: "debug" })],
  );
  app().clock.advance(31_000);
  // A line of the tenant starts the refresh; the new level is used once the refresh has finished.
  await postDeposit(ALPHA, `evt-warm-${randomUUID()}`, "p-warm");
  await app().levels.settled();
}

/** The compact story of one redemption: the event name, from>to for status changes, call:outcome for calls. */
const story = (redemptionId: string) =>
  logs()
    .filter((l) => l.redemptionId === redemptionId)
    .map((l) => {
      if (l.event === "redemption.status") return `status ${String(l.from)}>${String(l.to)}`;
      if (l.event === "platform.call") return `call ${String(l.call)}:${String(l.outcome)}`;
      return String(l.event);
    });

describe.skipIf(!running)("logs of the running service", () => {
  beforeEach(async () => {
    await fetch(`${fakeUrl()}/control/reset`, { method: "POST" });
    await app().db.query("UPDATE outbox SET done_at = now() WHERE done_at IS NULL");
    clearLogs();
  });

  test("1. a deposit and the same deposit again: one accepted and one duplicate line, with tenant and request id", async () => {
    const first = await postDeposit(ALPHA, "evt-dup", "p-dup");
    const second = await postDeposit(ALPHA, "evt-dup", "p-dup");
    const accepted = named("event.accepted");
    const duplicate = named("event.duplicate");
    expect(accepted).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      level: "info",
      tenantId: ALPHA,
      externalEventId: "evt-dup",
      kind: "deposit_succeeded",
      spinsGranted: 1,
      requestId: first.requestId,
    });
    expect(duplicate[0]).toMatchObject({
      level: "info",
      tenantId: ALPHA,
      externalEventId: "evt-dup",
      requestId: second.requestId,
    });
    expect(first.requestId).not.toBe(second.requestId);
    // The duplicate is a log line, not an audit entry.
    const audit = await app().db.query("SELECT count(*)::int AS n FROM audit_log WHERE request_id = $1", [
      second.requestId,
    ]);
    expect(audit.rows[0].n).toBe(0);
  });

  test("2. a full flow on platform A and on platform B writes the expected lines, each well formed", async () => {
    const a = await flow(ALPHA, "full-a");
    const b = await flow(BETA, "full-b");
    await deliver();
    expect(story(a.redemptionId)).toEqual([
      "redemption.created",
      "status created>reserved",
      "status reserved>submitting",
      "call find:not_found",
      "call issue:issued",
      "status submitting>issued",
      "status issued>settled",
    ]);
    expect(story(b.redemptionId)).toEqual([
      "redemption.created",
      "status created>reserved",
      "status reserved>submitting",
      "call find:not_found",
      "call issue:pending",
      "status submitting>issued",
      "status issued>settled",
    ]);
    for (const line of logs()) {
      expect(typeof line.at).toBe("string");
      expect(["error", "warn", "info", "debug"]).toContain(line.level);
      expect(typeof line.event).toBe("string");
      expect(line).toHaveProperty("tenantId");
      expect(line).toHaveProperty("requestId");
    }
    // Every line of a flow names its tenant and carries a request id or a job id.
    expect(logs().filter((l) => l.tenantId === null || l.requestId === null)).toEqual([]);
    expect(named("spin.used").map((l) => l.tenantId)).toEqual([ALPHA, BETA]);
    expect(named("redemption.created")[0]).toMatchObject({ playerId: expect.any(String), costCoins: "100" });
    // The settle of B ran from the callback webhook; the created line carries the id of its own request,
    // which is the id the audit rows of that request carry.
    const created = named("redemption.created").find((l) => l.redemptionId === a.redemptionId);
    const audit = await app().db.query("SELECT 1 FROM audit_log WHERE request_id = $1", [created?.requestId]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  test("3. verbosity is the tenant's policy: debug only for alpha after policy version 2 and the cache time", async () => {
    // Version 1 is "info" for both: a flow writes no debug line.
    await flow(ALPHA, "quiet-a");
    await flow(BETA, "quiet-b");
    await postIgnoredAlpha("e-quiet");
    expect(logs().filter((l) => l.level === "debug")).toEqual([]);

    await alphaAtDebug();
    // Beta's cache is stale too; the warm-up above refreshed only alpha, so touch beta the same way.
    await postDeposit(BETA, `evt-warm-${randomUUID()}`, "p-warm-b");
    await app().levels.settled();
    clearLogs();

    await flow(ALPHA, "loud-a");
    await postIgnoredAlpha("e-login");
    await flow(BETA, "loud-b");
    await postDeposit(BETA, "evt-ign-b", "p-ign-b", { extra: { kind: "WITHDRAWAL" } });

    const debugs = logs().filter((l) => l.level === "debug");
    expect(debugs.length).toBeGreaterThan(0);
    expect(debugs.every((l) => l.tenantId === ALPHA)).toBe(true);
    expect(named("spin.credited").map((l) => l.tenantId)).toEqual([ALPHA]);
    expect(named("event.ignored")).toHaveLength(1);
    expect(named("event.ignored")[0]).toMatchObject({
      tenantId: ALPHA,
      externalEventId: "e-login",
      why: "type player.login",
    });
    // Beta wrote its info lines, and none at debug.
    expect(logs().some((l) => l.tenantId === BETA && l.level === "info")).toBe(true);
    expect(logs().filter((l) => l.tenantId === BETA && l.level === "debug")).toEqual([]);
  });

  test("4. nothing secret, ever: rejected webhooks, a refusal, a lost answer, an admin resolution, alpha at debug", async () => {
    await alphaAtDebug();
    clearLogs();

    // Bad signatures on both platforms: the wrong secret signs the body.
    expect((await postDeposit(ALPHA, "evt-bad-a", "p-bad", { secret: "wrong-secret-a" })).status).toBe(401);
    expect((await postDeposit(BETA, "evt-bad-b", "p-bad", { secret: "wrong-secret-b" })).status).toBe(401);
    // A refused reward on A, and on B by callback.
    await fault("a.grant", "refuse");
    const refusedA = await flow(ALPHA, "ref-a");
    expect(refusedA.view.status).toBe("refused");
    await fault("b.grant", "refuse");
    const refusedB = await flow(BETA, "ref-b");
    await deliver();
    // A lost answer, found again by the look.
    await fault("a.grant", "lost_answer");
    const lost = await flow(ALPHA, "lost-a");
    expect(lost.view.status).toBe("submitting");
    await later(1000);
    // An admin resolves a redemption of B whose callback was lost.
    await fault("b.callback", "lost");
    const stuck = await flow(BETA, "stuck-b");
    await deliver();
    const resolved = await fetch(`${app().url}/admin/${BETA}/redemptions/${stuck.redemptionId}/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": tenantOf(BETA).adminKey,
        "x-admin-name": "dana",
      },
      body: JSON.stringify({ outcome: "issued", note: "casino confirmed by email" }),
    });
    expect(resolved.status).toBe(200);
    expect(refusedB.redemptionId).toBeTruthy();

    expect(named("webhook.rejected").map((l) => l.tenantId)).toEqual([ALPHA, BETA]);
    expect(named("admin.manual_resolution")).toHaveLength(1);
    expect(named("admin.manual_resolution")[0]).toMatchObject({
      level: "warn",
      tenantId: BETA,
      redemptionId: stuck.redemptionId,
      outcome: "issued",
      admin: "admin/dana",
    });
    expect(logs().some((l) => l.level === "debug" && l.tenantId === ALPHA)).toBe(true);

    const everything = app().rawLogs.join("\n");
    const secrets = demoTenants.flatMap((t) => [
      t.webhookSecret,
      t.tokenSecret,
      t.wheelSecret,
      t.adminKey,
      t.platformKey,
    ]);
    for (const secret of [...secrets, ...sentSecrets, "wrong-secret-a", "wrong-secret-b"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/Bearer\s+(?!\*\*\*)\S/i);
    // The lines are still useful: the redemption of the lost answer has its story.
    expect(story(lost.redemptionId)).toContain("platform.unreachable");
  });

  test("5. a lost answer writes platform.unreachable and then platform.call issued", async () => {
    await fault("a.grant", "lost_answer");
    const r = await flow(ALPHA, "lost-answer");
    expect(r.view.status).toBe("submitting");
    expect(story(r.redemptionId).slice(0, 5)).toEqual([
      "redemption.created",
      "status created>reserved",
      "status reserved>submitting",
      "call find:not_found",
      "platform.unreachable",
    ]);
    const unreachable = named("platform.unreachable")[0];
    expect(unreachable).toMatchObject({
      level: "warn",
      tenantId: ALPHA,
      redemptionId: r.redemptionId,
      call: "issue",
      retryInMs: 1000,
      ms: expect.any(Number),
    });
    expect(typeof unreachable?.error).toBe("string");
    await later(1000);
    const rest = story(r.redemptionId).slice(5);
    expect(rest).toEqual(["call find:issued", "status submitting>issued", "status issued>settled"]);
    const call = named("platform.call").find((l) => l.call === "find" && l.outcome === "issued");
    expect(call).toMatchObject({ level: "info", redemptionId: r.redemptionId, ms: expect.any(Number) });
    // The retry of the platform job is not a "dead" job.
    expect(named("outbox.dead")).toEqual([]);
  });

  test("6. a job that fails ten times writes outbox.dead, with the job id as request id", async () => {
    const JOB = randomUUID();
    await alphaAtDebug();
    clearLogs();
    outbox().handle("logging_test", async () => {
      throw new Error("boom");
    });
    await transaction(app().db, (tx) =>
      outbox().enqueue(tx, { tenantId: ALPHA, kind: "logging_test", refId: JOB }),
    );
    for (let i = 0; i < 10; i++) await later(61_000);
    const dead = named("outbox.dead");
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      level: "error",
      tenantId: ALPHA,
      kind: "logging_test",
      refId: JOB,
      attempts: 10,
      lastError: "boom",
      requestId: `job:logging_test:${JOB}`,
    });
    // Nine retries came before it. They are debug lines, and alpha is at debug.
    const retries = named("outbox.retry").filter((l) => l.kind === "logging_test");
    expect(retries.map((l) => l.attempts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(retries[0]).toMatchObject({ level: "debug", error: "boom", retryInMs: 1000 });
  });

  test("7. a supplied x-request-id is used by the lines of the request; an invalid one is replaced", async () => {
    const ok = await postDeposit(ALPHA, "evt-rid", "p-rid", { requestId: "client-req-7" });
    expect(ok.requestId).toBe("client-req-7");
    expect(named("event.accepted")[0]).toMatchObject({ requestId: "client-req-7" });
    clearLogs();
    const bad = await postDeposit(ALPHA, "evt-rid-2", "p-rid", { requestId: "bad id with spaces" });
    expect(bad.requestId).not.toBe("bad id with spaces");
    expect(named("event.accepted")[0]).toMatchObject({ requestId: bad.requestId });
  });

  test("8. log little: a happy deposit, spin and redemption writes 9 lines at info, 10 at debug", async () => {
    const a = await flow(ALPHA, "count-a");
    const notDebug = logs().filter((l) => l.level !== "debug");
    expect(notDebug.map((l) => l.event)).toEqual([
      "event.accepted",
      "spin.used",
      "redemption.created",
      "redemption.status",
      "redemption.status",
      "platform.call",
      "platform.call",
      "redemption.status",
      "redemption.status",
    ]);
    expect(notDebug.filter((l) => l.redemptionId === a.redemptionId)).toHaveLength(7);
    clearLogs();
    await flow(BETA, "count-b");
    await deliver();
    expect(logs()).toHaveLength(9); // beta stays at info; the callback webhook adds no line of its own
    await alphaAtDebug();
    clearLogs();
    await flow(ALPHA, "count-a2");
    expect(logs()).toHaveLength(10); // the only debug line of a happy flow is spin.credited
    expect(
      logs()
        .filter((l) => l.level === "debug")
        .map((l) => l.event),
    ).toEqual(["spin.credited"]);
  });
});

describe.skipIf(!running)("request id in the audit trail", () => {
  beforeEach(async () => {
    await fetch(`${fakeUrl()}/control/reset`, { method: "POST" });
    await app().db.query("UPDATE outbox SET done_at = now() WHERE done_at IS NULL");
    clearLogs();
  });

  test("every audit row of a spin and of a redemption on platform B carries a request id: the request's own, or job:<kind>:<ref>", async () => {
    const externalId = "p-rid-audit";
    const deposit = await postDeposit(BETA, "evt-rid-audit", externalId);
    const mine = await call<{ playerId: string; spins: { id: string }[] }>(BETA, externalId, "/me");
    const spinId = mine.json.spins[0]?.id as string;
    const spin = await call(BETA, externalId, `/wheel/spins/${spinId}/spin`, { method: "POST" });
    const item = (
      await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = 'bonus-1-eur'", [BETA])
    ).rows[0].id as string;
    await app()
      .app.get<CoinLedger>(COIN_LEDGER)
      .creditPrize({
        ledgerNo: tenantOf(BETA).ledgerNo,
        playerId: mine.json.playerId,
        spinId: randomUUID(),
        coins: 500n,
      });
    // The first grant answer is lost, so the request ends in "submitting" and an outbox job finishes it.
    await fault("b.grant", "lost_answer");
    const redeem = await call<View>(BETA, externalId, "/store/redemptions", {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({ itemId: item }),
    });
    expect(redeem.json.status).toBe("submitting");
    await later(60_000);
    await deliver(); // the callback that settles a platform B redemption

    const rows = (
      await app().db.query(
        `SELECT entity_type, action, request_id FROM audit_log
          WHERE (entity_type IN ('redemption', 'redemptions') AND entity_id = $1) OR (entity_type = 'spins' AND entity_id = $2)
          ORDER BY id`,
        [redeem.json.id, spinId],
      )
    ).rows as { entity_type: string; action: string; request_id: string | null }[];
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.filter((r) => r.request_id === null)).toEqual([]);
    // The callback webhook that settles B is a request of the fake casino; its id is a uuid we did not see.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const known = [spin.requestId, redeem.requestId, deposit.requestId];
    const allowed = (id: string) => known.includes(id) || id.startsWith("job:") || uuid.test(id);
    expect(rows.filter((r) => !allowed(r.request_id as string))).toEqual([]);
    // The spin row was created by the deposit request.
    expect(rows.some((r) => r.entity_type === "spins" && r.request_id === deposit.requestId)).toBe(true);
    // Both kinds are present: rows of the HTTP requests, and rows written by an outbox job.
    expect(rows.some((r) => r.request_id === redeem.requestId)).toBe(true);
    expect(rows.some((r) => r.request_id === spin.requestId)).toBe(true);
    expect(rows.some((r) => r.request_id?.startsWith("job:redemption"))).toBe(true);
  });

  test("one player has one actor name, player/<our player uuid>, in player create, spin and redemption rows", async () => {
    const before = (await app().db.query("SELECT coalesce(max(id), 0) AS id FROM audit_log")).rows[0].id;
    // The first call of the token creates the player; the flow then deposits, spins and redeems.
    const first = await call<{ playerId: string }>(ALPHA, "p-actor", "/me");
    const done = await flow(ALPHA, "actor");
    expect(done.externalId).toBe("p-actor");
    const actors = (
      await app().db.query("SELECT DISTINCT actor FROM audit_log WHERE id > $1 AND actor LIKE 'player/%'", [
        before,
      ])
    ).rows.map((r) => r.actor);
    expect(actors).toEqual([`player/${first.json.playerId}`]);
    // The rows really include the three kinds of row, so the check above means something.
    const kinds = (
      await app().db.query(
        "SELECT DISTINCT entity_type FROM audit_log WHERE id > $1 AND actor = $2 ORDER BY 1",
        [before, `player/${first.json.playerId}`],
      )
    ).rows.map((r) => r.entity_type);
    expect(kinds).toEqual(expect.arrayContaining(["players", "spins", "redemptions"]));
  });

  test("a new player and a new spin carry the injected clock's time, not the database's", async () => {
    app().clock.advance(24 * 3600 * 1000); // a day ahead of the database clock
    const at = app().clock.now();
    await postDeposit(ALPHA, "evt-clock", "p-clock");
    const player = (
      await app().db.query(
        "SELECT id, created_at FROM players WHERE tenant_id = $1 AND external_id = 'p-clock'",
        [ALPHA],
      )
    ).rows[0];
    const spin = (await app().db.query("SELECT created_at FROM spins WHERE player_id = $1", [player.id]))
      .rows[0];
    expect(player.created_at.toISOString()).toBe(at.toISOString());
    expect(spin.created_at.toISOString()).toBe(at.toISOString());
  });
});
