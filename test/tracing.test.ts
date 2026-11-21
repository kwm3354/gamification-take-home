import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { COIN_LEDGER, type CoinLedger } from "../src/domain/coin-ledger.ts";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { OUTBOX, type Outbox } from "../src/outbox/outbox.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { span, startTracing } from "../src/tracing/tracing.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";
import { alphaDeposit, betaTxn, signAlpha, signBeta, tokenFor } from "./signing.ts";

// The whole app over real HTTP with spans collected in memory. Skipped when no TigerBeetle is available.
// The casino URL points at a small forwarding server that records the headers it was called with.
const exporter = new InMemorySpanExporter();
let stopTracing = startTracing({ exporter });
const running = await startApp();
const fake: FakeCasino | undefined = running ? await startFake(running.url) : undefined;

const seen: { method: string; path: string; traceparent: string | undefined }[] = [];
let proxy: Server | undefined;
let proxyUrl = "";

const ALPHA = demoTenants[0] as (typeof demoTenants)[number];
const BETA = demoTenants[1] as (typeof demoTenants)[number];

beforeAll(async () => {
  if (!running || !fake) return;
  proxy = createServer(async (req, res) => {
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      traceparent: req.headers.traceparent as string | undefined,
    });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string" && k !== "host") headers[k] = v;
    const out = await fetch(`${fake.url}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(await out.text());
  });
  await new Promise<void>((r) => proxy?.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  await seedDemo(running.db, running.clock, proxyUrl);
});
afterAll(async () => {
  await running?.close();
  await fake?.close();
  proxy?.close();
  await stopTracing();
});
beforeEach(() => {
  exporter.reset();
  seen.length = 0;
});

const app = () => {
  if (!running) throw new Error("no app");
  return running;
};
const now = () => app().clock.now().getTime();
const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
const traceOf = (s: ReadableSpan) => s.spanContext().traceId;
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;
const byName = (name: string | RegExp) =>
  spans().filter((s) => (typeof name === "string" ? s.name === name : name.test(s.name)));
const first = (name: string | RegExp): ReadableSpan => {
  const s = byName(name)[0];
  if (!s)
    throw new Error(
      `no span ${name} in: ${spans()
        .map((x) => x.name)
        .join(" | ")}`,
    );
  return s;
};
/** True when `child` is below `ancestor` in the span tree. */
function below(child: ReadableSpan, ancestor: ReadableSpan): boolean {
  const byId = new Map(spans().map((s) => [s.spanContext().spanId, s]));
  let at: ReadableSpan | undefined = child;
  while (at) {
    const parentId = parentOf(at);
    if (!parentId) return false;
    if (parentId === ancestor.spanContext().spanId) return true;
    at = byId.get(parentId);
  }
  return false;
}

async function depositAlpha(externalId: string, extra: Record<string, string> = {}) {
  const body = alphaDeposit(`evt-${randomUUID()}`, externalId);
  const r = await fetch(`${app().url}/webhooks/${ALPHA.id}/events`, {
    method: "POST",
    headers: { ...signAlpha(ALPHA.webhookSecret, body, now()), ...extra },
    body,
  });
  return { r, body, json: await r.json() };
}
async function depositBeta(externalId: string) {
  const body = JSON.stringify({
    batchId: `b-${randomUUID()}`,
    transactions: [betaTxn(`T-${randomUUID()}`, externalId)],
  });
  const r = await fetch(`${app().url}/webhooks/${BETA.id}/events`, {
    method: "POST",
    headers: signBeta(BETA.webhookSecret, body),
    body,
  });
  return { r, body };
}
const tokenOf = (t: typeof ALPHA, externalId: string) => tokenFor(t.id, t.tokenSecret, externalId, now());
const auth = (t: typeof ALPHA, externalId: string) => ({ authorization: `Bearer ${tokenOf(t, externalId)}` });

async function meOf(t: typeof ALPHA, externalId: string) {
  const r = await fetch(`${app().url}/me`, { headers: auth(t, externalId) });
  return (await r.json()) as { playerId: string; spins: { id: string }[] };
}
async function spinOf(t: typeof ALPHA, externalId: string, spinId: string) {
  return fetch(`${app().url}/wheel/spins/${spinId}/spin`, { method: "POST", headers: auth(t, externalId) });
}
async function itemId(t: typeof ALPHA): Promise<string> {
  const r = await app().db.query("SELECT id FROM store_items WHERE tenant_id = $1 AND code = 'bonus-1-eur'", [
    t.id,
  ]);
  return r.rows[0].id;
}
async function playerWithCoins(t: typeof ALPHA, coins: bigint) {
  const externalId = `p-${randomUUID()}`;
  const { playerId } = await meOf(t, externalId);
  await app()
    .app.get<CoinLedger>(COIN_LEDGER)
    .creditPrize({ ledgerNo: t.ledgerNo, playerId, spinId: randomUUID(), coins });
  return externalId;
}
async function redeem(t: typeof ALPHA, externalId: string) {
  return fetch(`${app().url}/store/redemptions`, {
    method: "POST",
    headers: { ...auth(t, externalId), "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ itemId: await itemId(t) }),
  });
}

describe.skipIf(!running)("tracing", () => {
  test("1. a deposit is one http span with the database work under it, all in one trace", async () => {
    const { r } = await depositAlpha(`ext-${randomUUID()}`);
    expect(r.status).toBe(200);
    const root = first("http POST /webhooks/:tenantId/events");
    expect(r.headers.get("x-trace-id")).toBe(traceOf(root));
    expect(root.attributes["tenant.id"]).toBe(ALPHA.id);
    expect(root.attributes["http.response.status_code"]).toBe(200);
    expect(root.attributes["http.route"]).toBe("/webhooks/:tenantId/events");
    expect(root.attributes["http.request.method"]).toBe("POST");
    expect(root.attributes["request.id"]).toBe(r.headers.get("x-request-id"));
    expect(parentOf(root)).toBeUndefined();
    for (const name of ["db acquire", "db BEGIN", "db COMMIT", /^db INSERT /]) {
      const s = first(name);
      expect(traceOf(s)).toBe(traceOf(root));
      expect(below(s, root)).toBe(true);
    }
    expect(byName(/^db INSERT audit_log$/).length).toBeGreaterThan(0);
    expect(spans().every((s) => traceOf(s) === traceOf(root))).toBe(true);
  });

  test("2a. a spin has a ledger creditPrize span under the request span", async () => {
    const ext = `ext-${randomUUID()}`;
    await depositAlpha(ext);
    const spinId = (await meOf(ALPHA, ext)).spins[0]?.id as string;
    exporter.reset();
    const r = await spinOf(ALPHA, ext, spinId);
    expect(r.status).toBe(200);
    const root = first("http POST /wheel/spins/:spinId/spin");
    const credit = first("ledger creditPrize");
    expect(below(credit, root)).toBe(true);
    expect(r.headers.get("x-trace-id")).toBe(traceOf(root));
  });

  test("2b. a redemption on platform A: ledger reserve, platform issue A, ledger capture", async () => {
    const ext = await playerWithCoins(ALPHA, 500n);
    exporter.reset();
    const r = await redeem(ALPHA, ext);
    expect(r.status).toBe(201);
    const root = first("http POST /store/redemptions");
    const reserve = first("ledger reserve");
    const issue = first("platform issue A");
    const capture = first("ledger capture");
    for (const s of [reserve, issue, capture]) expect(below(s, root)).toBe(true);
    expect(reserve.attributes["ledger.result"]).toBe("reserved");
    expect(issue.attributes["http.response.status_code"]).toBe(201);
    expect(issue.attributes["tenant.id"]).toBe(ALPHA.id);
    const order = [reserve, issue, capture].map((s) => s.startTime[0] * 1e9 + s.startTime[1]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("2c. platform B: the settle runs in an outbox root span of its own", async () => {
    const ext = await playerWithCoins(BETA, 500n);
    app().config.inlineJobs = false;
    try {
      const r = await redeem(BETA, ext);
      expect(r.status).toBe(201);
      exporter.reset();
      await app().app.get<Outbox>(OUTBOX).drain();
    } finally {
      app().config.inlineJobs = true;
    }
    // The job runs in steps (reserve, then issue); each step is a root span of its own.
    const jobs = byName("outbox redemption_advance");
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(parentOf(job)).toBeUndefined();
      expect(["done", "retry"]).toContain(job.attributes["outbox.result"]);
      expect(typeof job.attributes["outbox.attempts"]).toBe("number");
      expect(String(job.attributes["request.id"])).toMatch(/^job:redemption_advance:/);
    }
    const issue = first("platform issue B");
    expect(jobs.some((job) => below(issue, job))).toBe(true);
    expect(byName("http POST /store/redemptions")).toHaveLength(0);
  });

  test("3. an incoming traceparent is continued", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const { r } = await depositAlpha(`ext-${randomUUID()}`, {
      traceparent: `00-${traceId}-b7ad6b7169203331-01`,
    });
    expect(r.headers.get("x-trace-id")).toBe(traceId);
    const root = first("http POST /webhooks/:tenantId/events");
    expect(traceOf(root)).toBe(traceId);
    expect(parentOf(root)).toBe("b7ad6b7169203331");
  });

  test("4. the call to the casino carries the traceparent of the request", async () => {
    const ext = await playerWithCoins(ALPHA, 500n);
    exporter.reset();
    seen.length = 0;
    const r = await redeem(ALPHA, ext);
    expect(r.status).toBe(201);
    const post = seen.find((c) => c.method === "POST" && c.path.startsWith("/a/bonuses"));
    expect(post?.traceparent).toBeDefined();
    const [, traceId, spanId] = (post?.traceparent as string).split("-");
    expect(traceId).toBe(r.headers.get("x-trace-id"));
    expect(spanId).toBe(first("platform issue A").spanContext().spanId);
  });

  test("5. nothing secret in any span: names, attributes, events", async () => {
    const external = `needle-player-${randomUUID()}`;
    await depositAlpha(external);
    await depositBeta(external);
    for (const t of [ALPHA, BETA]) {
      const ext = t === ALPHA ? external : `needle-b-${randomUUID()}`;
      if (t === BETA) await depositBeta(ext);
      const { playerId, spins } = await meOf(t, ext);
      await spinOf(t, ext, spins[0]?.id as string);
      await app()
        .app.get<CoinLedger>(COIN_LEDGER)
        .creditPrize({ ledgerNo: t.ledgerNo, playerId, spinId: randomUUID(), coins: 500n });
      await redeem(t, ext);
      await fetch(`${app().url}/webhooks/${t.id}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-alpha-signature": "forged-sig-value",
          "x-beta-auth": "forged-sig-value",
        },
        body: "{}",
      });
    }
    await app().app.get<Outbox>(OUTBOX).drain();
    expect(spans().length).toBeGreaterThan(20);
    const everything = JSON.stringify(
      spans().map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    const secrets = demoTenants.flatMap((t) => [
      t.webhookSecret,
      t.tokenSecret,
      t.wheelSecret,
      t.platformKey,
    ]);
    for (const secret of secrets) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("Bearer ");
    expect(everything).not.toContain("forged-sig-value");
    // A signature of a request we sent: the signed deposit's header value and the token itself.
    const sentSignature = signAlpha(ALPHA.webhookSecret, alphaDeposit("x", "y"), now())["x-alpha-signature"];
    expect(everything).not.toContain(sentSignature);
    expect(everything).not.toContain(tokenOf(ALPHA, external));
    // SQL parameter values: the external player id went in as a parameter and must not be in any statement.
    const statements = spans().flatMap((s) =>
      s.attributes["db.statement"] ? [String(s.attributes["db.statement"])] : [],
    );
    expect(statements.length).toBeGreaterThan(10);
    for (const st of statements) {
      expect(st).not.toContain("needle");
      expect(st.length).toBeLessThanOrEqual(200);
    }
    expect(everything).not.toContain("needle");
  });

  test("6. a failing span has error status and the exception, and the error is the same one", async () => {
    const boom = new Error("boom");
    let seenByCaller: unknown;
    try {
      span(
        "outer",
        {},
        () =>
          span("inner sync", {}, () => {
            throw boom;
          }),
        { root: true },
      );
    } catch (e) {
      seenByCaller = e;
    }
    expect(seenByCaller).toBe(boom);
    let late: unknown;
    try {
      await span(
        "outer2",
        {},
        () =>
          span("inner async", {}, async () => {
            throw boom;
          }),
        { root: true },
      );
    } catch (e) {
      late = e;
    }
    expect(late).toBe(boom);
    for (const name of ["inner sync", "inner async"]) {
      const s = first(name);
      expect(s.status.code).toBe(2); // ERROR
      expect(s.events.some((e) => e.name === "exception")).toBe(true);
    }
    expect(first("outer").status.code).toBe(2);
    // The result of a good call is returned unchanged, sync and async.
    expect(span("ok", {}, () => 7, { root: true })).toBe(7);
    expect(await span("ok2", {}, async () => "v", { root: true })).toBe("v");
  });

  test("8. log lines written inside a traced request carry the trace id", async () => {
    app().logs.length = 0;
    const { r } = await depositAlpha(`ext-${randomUUID()}`);
    const lines = app().logs.filter((l) => l.event === "event.accepted");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.traceId).toBe(r.headers.get("x-trace-id"));
    expect(lines[0]?.requestId).toBe(first("http POST /webhooks/:tenantId/events").attributes["request.id"]);
  });

  test("9. sample ratio: 0 records nothing, 1 records everything, and a sampled request keeps its children", async () => {
    const mine = new InMemorySpanExporter();
    await stopTracing();
    stopTracing = startTracing({ exporter: mine, sampleRatio: 0 });
    await depositAlpha(`ext-${randomUUID()}`);
    expect(mine.getFinishedSpans()).toHaveLength(0);
    const full = new InMemorySpanExporter(); // starting again shuts the old exporter down
    stopTracing = startTracing({ exporter: full, sampleRatio: 1 });
    await depositAlpha(`ext-${randomUUID()}`);
    const all = full.getFinishedSpans();
    expect(all.length).toBeGreaterThan(5);
    expect(new Set(all.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  // Last: it turns tracing off for the rest of the file.
  test("7. tracing off: no spans, no x-trace-id, x-request-id stays, logs have no traceId", async () => {
    await stopTracing();
    stopTracing = async () => {};
    exporter.reset();
    app().logs.length = 0;
    const { r } = await depositAlpha(`ext-${randomUUID()}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-trace-id")).toBeNull();
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(spans()).toHaveLength(0);
    const line = app().logs.find((l) => l.event === "event.accepted");
    expect(line).toBeDefined();
    expect("traceId" in (line as object)).toBe(false);
  });
});
