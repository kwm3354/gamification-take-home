import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type DemoTenant, demoTenants } from "../tenants/demo-tenants.ts";
import { now } from "./clock.ts";
import { buildDeposit, newEventId } from "./deposit.ts";
import { type FaultPoint, Faults, validFaults } from "./faults.ts";
import { aFind, aGrant, parseAGrant } from "./platform-a.ts";
import { bFind, bGrant, deliverAll, parseBGrant } from "./platform-b.ts";
import { signJwt } from "./signing.ts";
import { type FakeState, type Reply, World, isoNow, toMinor } from "./state.ts";

export interface FakeCasinoOptions {
  port?: number;
  appUrl?: string;
  /** The app's address as the browser sees it, for the playground page. Default http://localhost:30080. */
  publicAppUrl?: string;
  /** Deliver platform B callbacks by timer. Null or missing: only by hand. */
  autoDeliverMs?: number | null;
}

export interface FakeCasino {
  url: string;
  state: () => FakeState;
  close: () => Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const MAX_BODY = 1_000_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): Json {
  if (raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Json;
}

function str(body: Json, key: string, fallback?: string): string {
  const v = body[key] ?? fallback;
  if (typeof v !== "string" || v === "") throw new HttpError(400, `${key} is required`);
  return v;
}

function tenantById(id: string): DemoTenant {
  const tenant = demoTenants.find((t) => t.id === id);
  if (!tenant) throw new HttpError(400, `unknown tenant ${id}`);
  return tenant;
}

export async function startFakeCasino(options: FakeCasinoOptions = {}): Promise<FakeCasino> {
  const world = new World();
  const faults = new Faults();
  const appUrl = (options.appUrl ?? "http://app:3000").replace(/\/$/, "");
  const publicAppUrl = (options.publicAppUrl ?? "http://localhost:30080").replace(/\/$/, "");
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;

  function send(res: ServerResponse, reply: Reply): void {
    if (res.destroyed || res.writableEnded) return;
    const payload = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      ...reply.headers,
    });
    res.end(payload);
  }

  /** Runs one platform API call through the fault rules. `work` does the real effect. */
  async function withFault(
    res: ServerResponse,
    tenant: DemoTenant,
    point: FaultPoint,
    reference: string | null,
    work: (refuse: boolean) => Reply,
  ): Promise<void> {
    const applied = faults.take(point, tenant.id);
    world.requests.push({
      tenantId: tenant.id,
      point,
      reference,
      at: isoNow(),
      fault: applied?.fault ?? null,
    });
    switch (applied?.fault) {
      case "error_500":
        return send(res, { status: 500, body: { error: "fake_internal_error" } });
      case "rate_limit":
        return send(res, { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } });
      case "lost_request":
        res.socket?.destroy();
        return;
      case "lost_answer":
        work(false);
        res.socket?.destroy();
        return;
      case "slow_answer": {
        const reply = work(false);
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(res, reply);
        }, applied.delayMs);
        timer.unref();
        timers.add(timer);
        return;
      }
      case "refuse":
        return send(res, work(true));
      default:
        return send(res, work(false));
    }
  }

  function tenantForApi(req: IncomingMessage, platform: "A" | "B"): DemoTenant {
    let key: string | undefined;
    if (platform === "A") {
      const auth = req.headers.authorization ?? "";
      key = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    } else {
      const header = req.headers["x-api-key"];
      key = Array.isArray(header) ? header[0] : header;
    }
    const tenant = demoTenants.find((t) => key !== undefined && t.platformKey === key);
    if (!tenant) throw new HttpError(401, "unknown api key");
    if (tenant.platform !== platform) throw new HttpError(404, "not found");
    return tenant;
  }

  async function postJson(url: string, raw: string, headers: Record<string, string>) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: raw,
        signal: AbortSignal.timeout(5000),
      });
      const text = await r.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep the text
      }
      return { status: r.status, body };
    } catch (err) {
      return { status: 0, body: String(err) };
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/") {
      try {
        const page = await readFile(new URL("./public/index.html", import.meta.url));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no page yet");
      }
      return;
    }

    // For the playground page.
    if (method === "GET" && path === "/control/config") {
      return send(res, {
        status: 200,
        body: {
          appUrl: publicAppUrl,
          tenants: demoTenants.map((t) => ({
            id: t.id,
            name: t.name,
            platform: t.platform,
          })),
        },
      });
    }

    // Platform A
    if (method === "POST" && path === "/a/bonuses") {
      const tenant = tenantForApi(req, "A");
      const body = parseJson(await readBody(req));
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key === "") throw new HttpError(400, "Idempotency-Key is required");
      const input = parseAGrant(body);
      if (typeof input === "string") throw new HttpError(400, input);
      world.meet(tenant.id, input.playerId, input.reference);
      return withFault(res, tenant, "a.grant", input.reference, (refuse) =>
        aGrant(world, tenant, key, input, refuse),
      );
    }
    if (method === "GET" && path === "/a/bonuses") {
      const tenant = tenantForApi(req, "A");
      const reference = url.searchParams.get("reference");
      if (!reference) throw new HttpError(400, "reference is required");
      return withFault(res, tenant, "a.find", reference, () => aFind(world, tenant, reference));
    }

    // Platform B
    if (method === "POST" && path === "/b/v2/rewards/grant") {
      const tenant = tenantForApi(req, "B");
      const input = parseBGrant(parseJson(await readBody(req)));
      if (typeof input === "string") throw new HttpError(400, input);
      world.meet(tenant.id, input.customerId, input.externalRef);
      return withFault(res, tenant, "b.grant", input.externalRef, (refuse) =>
        bGrant(world, tenant, input, refuse),
      );
    }
    if (method === "GET" && path === "/b/v2/rewards/requests") {
      const tenant = tenantForApi(req, "B");
      const ref = url.searchParams.get("externalRef");
      if (!ref) throw new HttpError(400, "externalRef is required");
      return withFault(res, tenant, "b.find", ref, () => bFind(world, tenant, ref));
    }

    // Control API
    if (method === "GET" && path === "/control/state")
      return send(res, { status: 200, body: world.snapshot() });
    // Players the casino has met and the references they asked for. The control page's check reads it.
    if (method === "GET" && path === "/control/players")
      return send(res, { status: 200, body: world.playerList() });
    if (method === "GET" && path === "/control/faults")
      return send(res, { status: 200, body: faults.list() });
    if (method === "POST" && path === "/control/reset") {
      await readBody(req);
      world.reset();
      faults.clear();
      return send(res, { status: 200, body: { ok: true } });
    }
    if (method === "POST" && path === "/control/faults/clear") {
      await readBody(req);
      faults.clear();
      return send(res, { status: 200, body: faults.list() });
    }
    if (method === "POST" && path === "/control/faults") {
      const body = parseJson(await readBody(req));
      const point = str(body, "point") as FaultPoint;
      const fault = str(body, "fault");
      if (!validFaults[point]?.includes(fault))
        throw new HttpError(400, `fault ${fault} is not valid at ${point}`);
      const times = body.times === undefined ? 1 : body.times;
      if (!Number.isInteger(times) || (times as number) < 1)
        throw new HttpError(400, "times must be a positive integer");
      const delayMs = body.delayMs === undefined ? undefined : body.delayMs;
      if (delayMs !== undefined && (typeof delayMs !== "number" || delayMs < 0))
        throw new HttpError(400, "delayMs must be a number");
      const tenantId = body.tenantId === undefined ? undefined : str(body, "tenantId");
      faults.add({ point, fault, times: times as number, delayMs: delayMs as number | undefined, tenantId });
      return send(res, { status: 200, body: faults.list() });
    }
    if (method === "POST" && path === "/control/chaos") {
      const body = parseJson(await readBody(req));
      if (body.seed === null) {
        faults.setChaos(null, {});
        return send(res, { status: 200, body: { chaos: "off" } });
      }
      if (typeof body.seed !== "number" || !Number.isFinite(body.seed))
        throw new HttpError(400, "seed must be a number or null");
      const rates = body.rates;
      if (typeof rates !== "object" || rates === null) throw new HttpError(400, "rates is required");
      for (const [point, byFault] of Object.entries(rates as Json)) {
        if (!(point in validFaults)) throw new HttpError(400, `unknown point ${point}`);
        for (const [fault, rate] of Object.entries(byFault as Json)) {
          if (!validFaults[point as FaultPoint].includes(fault))
            throw new HttpError(400, `fault ${fault} is not valid at ${point}`);
          if (typeof rate !== "number" || rate < 0 || rate > 1)
            throw new HttpError(400, "a rate must be between 0 and 1");
        }
      }
      faults.setChaos(body.seed, rates as Record<string, Record<string, number>>);
      return send(res, { status: 200, body: { chaos: "on", seed: body.seed } });
    }
    if (method === "POST" && path === "/control/b/deliver") {
      await readBody(req);
      return send(res, { status: 200, body: { delivered: await deliverAll(world, faults, appUrl) } });
    }
    if (method === "POST" && path === "/control/deposit") {
      const body = parseJson(await readBody(req));
      const tenant = tenantById(str(body, "tenantId"));
      const amount = str(body, "amount");
      if (toMinor(amount) === null) throw new HttpError(400, "amount must be a decimal string like 20.00");
      const repeat = body.repeat === undefined ? 1 : body.repeat;
      if (!Number.isInteger(repeat) || (repeat as number) < 1 || (repeat as number) > 100)
        throw new HttpError(400, "repeat must be 1..100");
      const tamper = body.tamper === undefined ? undefined : str(body, "tamper");
      if (tamper !== undefined && !["signature", "stale", "failed"].includes(tamper))
        throw new HttpError(400, "unknown tamper");
      if (tamper === "stale" && tenant.platform !== "A")
        throw new HttpError(400, "stale applies to platform A only");
      const eventId = body.eventId === undefined ? newEventId() : str(body, "eventId");
      world.meet(tenant.id, str(body, "playerId"));
      const { raw, headers } = buildDeposit({
        tenant,
        playerId: str(body, "playerId"),
        amount,
        currency: str(body, "currency", "EUR"),
        eventId,
        tamper,
      });
      const target = (typeof body.ourUrl === "string" && body.ourUrl ? body.ourUrl : appUrl).replace(
        /\/$/,
        "",
      );
      const sent = [];
      for (let i = 0; i < (repeat as number); i++) {
        sent.push(await postJson(`${target}/webhooks/${tenant.id}/events`, raw, headers));
      }
      return send(res, { status: 200, body: { eventId, sent } });
    }
    if (method === "POST" && path === "/control/token") {
      const body = parseJson(await readBody(req));
      const tenant = tenantById(str(body, "tenantId"));
      const ttl = body.ttlSeconds === undefined ? 600 : body.ttlSeconds;
      if (typeof ttl !== "number" || !Number.isFinite(ttl))
        throw new HttpError(400, "ttlSeconds must be a number");
      const tamper = body.tamper === undefined ? undefined : str(body, "tamper");
      if (tamper !== undefined && !["signature", "expired"].includes(tamper))
        throw new HttpError(400, "unknown tamper");
      world.meet(tenant.id, str(body, "playerId"));
      const iat = Math.floor(now() / 1000);
      const claims = {
        iss: tenant.id,
        sub: str(body, "playerId"),
        iat,
        exp: tamper === "expired" ? iat - 60 : iat + ttl,
      };
      const secret = tamper === "signature" ? `${tenant.tokenSecret}-wrong` : tenant.tokenSecret;
      return send(res, { status: 200, body: { token: signJwt(claims, secret) } });
    }

    throw new HttpError(404, "not found");
  }

  const server: Server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "content-type",
      });
      res.end();
      return;
    }
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, { status: err.status, body: { error: err.message } });
      console.error("fake casino: unexpected error", err);
      send(res, { status: 500, body: { error: "fake_internal_error" } });
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  if (options.autoDeliverMs) {
    let running = false;
    const timer = setInterval(() => {
      if (running || closed) return;
      running = true;
      deliverAll(world, faults, appUrl)
        .catch((err) => console.error("fake casino: auto deliver failed", err))
        .finally(() => {
          running = false;
        });
    }, options.autoDeliverMs);
    timer.unref();
    timers.add(timer);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "0.0.0.0", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    state: () => world.snapshot(),
    close: async () => {
      closed = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
