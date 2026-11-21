/**
 * Load script. Plain Node 22 (global fetch, node:crypto), no dependencies.
 *
 *   npx tsx scripts/load.ts --scenario deposit --n 2000 --c 32
 *
 * Options: --url (default http://127.0.0.1:30080), --tenant (alpha-casino | beta-casino),
 * --scenario, --n (measured requests; for `mixed`: cycles), --c (concurrency), --warm (unmeasured
 * requests first, default 10 % of n, at least 50), --players (for `me`: how many players, default 200).
 *
 * Scenarios: deposit, deposit-b, duplicate, spin, me, wheel, redeem-a, redeem-b, mixed.
 * It signs deposit events and player tokens itself with the demo secrets, so the fake casino is not
 * in the path of deposits, spins or reads. The JSON summary goes to stdout; progress goes to stderr.
 *
 * Node's fetch (undici) keeps connections alive and reuses them. Check while a run is going:
 *   ss -tn state established '( dport = :30080 )' | wc -l     (about the concurrency, not about n)
 */
import { createHmac, randomBytes } from "node:crypto";

const demo = {
  "alpha-casino": {
    platform: "A",
    webhookSecret: "demo-alpha-webhook-secret",
    tokenSecret: "demo-alpha-token-secret-0123456789abcdef",
  },
  "beta-casino": {
    platform: "B",
    webhookSecret: "demo-beta-webhook-secret",
    tokenSecret: "demo-beta-token-secret-0123456789abcdef",
  },
} as const;

// ---- options ----------------------------------------------------------------------------------
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]?.replace(/^--/, "") ?? "", process.argv[i + 1] ?? "");
const BASE = args.get("url") ?? "http://127.0.0.1:30080";
const scenario = args.get("scenario") ?? "deposit";
const N = Number(args.get("n") ?? 2000);
const C = Number(args.get("c") ?? 8);
const WARM = Number(args.get("warm") ?? Math.max(50, Math.floor(N / 10)));
const ME_PLAYERS = Number(args.get("players") ?? 200);
const defaultTenant = scenario === "deposit-b" || scenario === "redeem-b" ? "beta-casino" : "alpha-casino";
const TENANT = (args.get("tenant") ?? defaultTenant) as keyof typeof demo;
const cfg = demo[TENANT];
if (!cfg) throw new Error(`unknown tenant ${TENANT}`);
const RUN = `ld${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const log = (...a: unknown[]) => console.error(`[load ${scenario} c=${C}]`, ...a);

// ---- signing (the same approach as test/signing.ts, written again here) --------------------------
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data);
const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function tokenFor(sub: string): string {
  const input = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({
    iss: TENANT,
    sub,
    exp: Math.floor(Date.now() / 1000) + 840,
  })}`;
  return `${input}.${hmac(cfg.tokenSecret, input).digest("base64url")}`;
}
function alphaHeaders(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-alpha-timestamp": ts,
    "x-alpha-signature": hmac(cfg.webhookSecret, `${ts}.${body}`).digest("hex"),
  };
}
function betaHeaders(body: string) {
  return { "content-type": "application/json", "x-beta-auth": hmac(cfg.webhookSecret, body).digest("base64") };
}
const alphaBody = (eventId: string, playerId: string) =>
  JSON.stringify({
    event_id: eventId,
    type: "deposit.succeeded",
    player_id: playerId,
    amount_minor: 2000,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
  });
const betaTxn = (txnId: string, customerId: string) => ({
  txnId,
  kind: "DEPOSIT",
  state: "COMPLETED",
  customer: { id: customerId },
  amount: "20.00",
  currencyCode: "EUR",
  completedAt: Math.floor(Date.now() / 1000),
});
const betaBody = (txns: ReturnType<typeof betaTxn>[]) =>
  JSON.stringify({ batchId: `${RUN}-b-${randomBytes(4).toString("hex")}`, transactions: txns });

// ---- one HTTP call, measured ---------------------------------------------------------------------
interface Sample {
  name: string;
  ms: number;
  status: string;
}
interface Reply {
  status: number;
  json: any;
  ms: number;
}
async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  sink?: Sample[],
  name = "call",
): Promise<Reply> {
  const t0 = performance.now();
  let status = 0;
  let json: any = null;
  let label: string;
  try {
    const res = await fetch(BASE + path, { method, headers, body });
    status = res.status;
    const text = await res.text(); // read to the end so the connection goes back to the pool
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    label = String(status);
  } catch (e) {
    label = `exc:${(e as Error).name}:${((e as Error).cause as { code?: string } | undefined)?.code ?? ""}`;
  }
  const ms = performance.now() - t0;
  sink?.push({ name, ms, status: label });
  return { status, json, ms };
}

const ok = (r: Reply) => r.status >= 200 && r.status < 300;

/** Runs `total` tasks with at most `c` at a time. */
async function pool(total: number, c: number, task: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      await task(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(c, total) }, worker));
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}
const r1 = (x: number) => Math.round(x * 10) / 10;
function summarize(samples: Sample[]) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors: Record<string, number> = {};
  for (const s of samples) {
    if (!s.status.startsWith("2")) errors[s.status] = (errors[s.status] ?? 0) + 1;
  }
  return {
    count: samples.length,
    errors,
    p50: r1(pct(lat, 50)),
    p90: r1(pct(lat, 90)),
    p99: r1(pct(lat, 99)),
    max: r1(lat[lat.length - 1] ?? 0),
  };
}

// ---- helpers for the player side -------------------------------------------------------------------
interface P {
  id: string; // the platform's player id
  token: string;
}
const newPlayer = (i: number): P => {
  const id = `${RUN}-p${i}`;
  return { id, token: tokenFor(id) };
};
const auth = (p: P, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${p.token}`, ...extra });

let eventSeq = 0;
/** One deposit for one player, either platform. */
function deposit(p: P, sink?: Sample[]): Promise<Reply> {
  const eid = `${RUN}-e${eventSeq++}`;
  if (cfg.platform === "A") {
    const body = alphaBody(eid, p.id);
    return call("POST", `/webhooks/${TENANT}/events`, alphaHeaders(body), body, sink, "deposit");
  }
  const body = betaBody([betaTxn(eid, p.id)]);
  return call("POST", `/webhooks/${TENANT}/events`, betaHeaders(body), body, sink, "deposit");
}
const me = (p: P, sink?: Sample[]) => call("GET", "/me", auth(p), undefined, sink, "me");
const spinCall = (p: P, spinId: string, sink?: Sample[]) =>
  call("POST", `/wheel/spins/${spinId}/spin`, auth(p), undefined, sink, "spin");

async function itemId(p: P, code: string): Promise<string> {
  const r = await call("GET", "/store/items", auth(p));
  const item = (r.json as { id: string; code: string }[]).find((x) => x.code === code);
  if (!item) throw new Error(`no store item ${code}`);
  return item.id;
}

/** Players with one deposit each (one available spin each). */
async function playersWithSpin(total: number): Promise<{ p: P; spinId: string }[]> {
  const out: { p: P; spinId: string }[] = new Array(total);
  await pool(total, 32, async (i) => {
    const p = newPlayer(i);
    const d = await deposit(p);
    if (!ok(d)) throw new Error(`setup deposit failed: ${d.status}`);
    const m = await me(p);
    const s = (m.json.spins as { id: string; status: string }[]).find((x) => x.status === "available");
    if (!s) throw new Error("setup: no spin");
    out[i] = { p, spinId: s.id };
  });
  return out;
}

/** Players with at least `need` coins available: deposit, spin everything, repeat. */
async function playersWithCoins(total: number, need = 100): Promise<P[]> {
  const out: P[] = new Array(total);
  await pool(total, 32, async (i) => {
    const p = newPlayer(i);
    for (let round = 0; round < 40; round++) {
      await deposit(p);
      await deposit(p);
      const m = await me(p);
      for (const s of m.json.spins as { id: string; status: string }[]) {
        if (s.status === "available") await spinCall(p, s.id);
      }
      const after = await me(p);
      if (after.json.balance && Number(after.json.balance.available) >= need) {
        out[i] = p;
        return;
      }
    }
    throw new Error(`setup: player ${p.id} never reached ${need} coins`);
  });
  return out;
}

// ---- scenarios ---------------------------------------------------------------------------------------
async function measure(
  fn: (i: number, sink: Sample[]) => Promise<void>,
  total: number,
  warm: number,
): Promise<{ samples: Sample[]; wallMs: number }> {
  if (warm > 0) {
    log(`warm-up ${warm}`);
    await pool(warm, C, (i) => fn(i, []));
  }
  const samples: Sample[] = [];
  log(`measuring ${total}`);
  const t0 = performance.now();
  await pool(total, C, (i) => fn(warm + i, samples));
  return { samples, wallMs: performance.now() - t0 };
}

const out: Record<string, unknown> = { scenario, tenant: TENANT, platform: cfg.platform, c: C, n: N, warm: WARM, run: RUN };
let samples: Sample[] = [];
let wallMs = 0;

if (scenario === "deposit") {
  ({ samples, wallMs } = await measure(async (i, sink) => void (await deposit(newPlayer(i), sink)), N, WARM));
} else if (scenario === "deposit-b") {
  const perBatch = 10;
  ({ samples, wallMs } = await measure(
    async (i, sink) => {
      const txns = Array.from({ length: perBatch }, (_, k) =>
        betaTxn(`${RUN}-t${i}-${k}`, `${RUN}-p${i * perBatch + k}`),
      );
      const body = betaBody(txns);
      await call("POST", `/webhooks/${TENANT}/events`, betaHeaders(body), body, sink, "deposit-b");
    },
    N,
    WARM,
  ));
  out.transactionsPerRequest = perBatch;
  out.transactionsPerSecond = r1(((samples.length * perBatch) / wallMs) * 1000);
} else if (scenario === "duplicate") {
  const p = newPlayer(0);
  const eid = `${RUN}-dup`;
  const send = (sink?: Sample[]) => {
    if (cfg.platform === "A") {
      const body = alphaBody(eid, p.id);
      return call("POST", `/webhooks/${TENANT}/events`, alphaHeaders(body), body, sink, "duplicate");
    }
    const body = JSON.stringify({ batchId: `${RUN}-dupb`, transactions: [betaTxn(eid, p.id)] });
    return call("POST", `/webhooks/${TENANT}/events`, betaHeaders(body), body, sink, "duplicate");
  };
  const first = await send();
  out.firstAnswer = first.json;
  ({ samples, wallMs } = await measure(async (_i, sink) => void (await send(sink)), N, WARM));
} else if (scenario === "spin") {
  log(`preparing ${N + WARM} players with one spin`);
  const prepared = await playersWithSpin(N + WARM);
  ({ samples, wallMs } = await measure(
    async (i, sink) => {
      const x = prepared[i] as { p: P; spinId: string };
      await spinCall(x.p, x.spinId, sink);
    },
    N,
    WARM,
  ));
} else if (scenario === "me" || scenario === "wheel") {
  const total = Math.min(ME_PLAYERS, N + WARM);
  log(`preparing ${total} players (deposit + spin)`);
  const prepared = await playersWithSpin(total);
  for (const x of prepared) await spinCall(x.p, x.spinId);
  ({ samples, wallMs } = await measure(
    async (i, sink) => {
      const x = prepared[i % total] as { p: P };
      if (scenario === "me") await me(x.p, sink);
      else await call("GET", "/wheel", auth(x.p), undefined, sink, "wheel");
    },
    N,
    WARM,
  ));
} else if (scenario === "redeem-a" || scenario === "redeem-b") {
  log(`preparing ${N + WARM} players with >= 100 coins`);
  const players = await playersWithCoins(N + WARM);
  const item = await itemId(players[0] as P, "bonus-1-eur");
  const started = new Map<string, number>(); // redemption id -> start (ms, performance clock)
  const ids: { p: P; id: string }[] = [];
  const mark = { first: 0, endRedeem: 0 };
  ({ samples, wallMs } = await measure(
    async (i, sink) => {
      const p = players[i] as P;
      const t0 = performance.now();
      if (i === WARM) mark.first = t0;
      const r = await call(
        "POST",
        "/store/redemptions",
        auth(p, { "content-type": "application/json", "idempotency-key": `${RUN}-r${i}` }),
        JSON.stringify({ itemId: item }),
        sink,
        "redeem",
      );
      if (i >= WARM && ok(r) && r.json?.id) {
        started.set(r.json.id, t0);
        ids.push({ p, id: r.json.id });
      }
    },
    N,
    WARM,
  ));
  mark.endRedeem = performance.now();
  const statuses: Record<string, number> = {};
  for (const x of ids) {
    /* counted below after polling */
    void x;
  }
  // Time until every redemption is final. Platform B confirms by webhook, about a second later.
  const final = new Map<string, number>();
  const finalStatus = new Map<string, string>();
  const isFinal = (s: string) => s === "issued" || s === "refused" || s === "insufficient";
  const deadline = performance.now() + 120_000;
  while (final.size < ids.length && performance.now() < deadline) {
    const pending = ids.filter((x) => !final.has(x.id));
    await pool(pending.length, 16, async (k) => {
      const x = pending[k] as { p: P; id: string };
      const r = await call("GET", `/store/redemptions/${x.id}`, auth(x.p));
      if (ok(r) && isFinal(r.json.status) && r.json.settled === true) {
        final.set(x.id, performance.now());
        finalStatus.set(x.id, r.json.status);
      }
    });
    if (final.size < ids.length) await new Promise((r) => setTimeout(r, 100));
  }
  for (const s of finalStatus.values()) statuses[s] = (statuses[s] ?? 0) + 1;
  const perRedemption = [...final.entries()].map(([id, t]) => t - (started.get(id) as number)).sort((a, b) => a - b);
  out.redemptions = {
    created: ids.length,
    finalAndSettled: final.size,
    notFinalAfterPoll: ids.length - final.size,
    finalStatuses: statuses,
    msFromFirstRequestStartToLastFinal: final.size ? r1(Math.max(...final.values()) - mark.first) : null,
    msFromRedeemPhaseEndToLastFinal: final.size ? r1(Math.max(...final.values()) - mark.endRedeem) : null,
    startToFinalMsP50: r1(pct(perRedemption, 50)),
    startToFinalMsP99: r1(pct(perRedemption, 99)),
    startToFinalMsMax: r1(perRedemption[perRedemption.length - 1] ?? 0),
  };
} else if (scenario === "mixed") {
  const sink: Sample[] = [];
  const cycles: number[] = [];
  const vps = Array.from({ length: C }, (_, i) => newPlayer(i));
  let item = "";
  item = await itemId(vps[0] as P, "bonus-1-eur");
  let done = 0;
  const cycle = async (p: P, s: Sample[]) => {
    const t0 = performance.now();
    await deposit(p, s);
    const m = await me(p, s);
    const open = (m.json?.spins as { id: string; status: string }[] | undefined)?.find((x) => x.status === "available");
    if (open) await spinCall(p, open.id, s);
    const m2 = await me(p, s);
    if (m2.json?.balance && Number(m2.json.balance.available) >= 100) {
      await call(
        "POST",
        "/store/redemptions",
        auth(p, { "content-type": "application/json", "idempotency-key": `${RUN}-r${eventSeq++}` }),
        JSON.stringify({ itemId: item }),
        s,
        "redeem",
      );
    }
    return performance.now() - t0;
  };
  log(`warm-up ${C * 2} cycles`);
  await Promise.all(vps.map(async (p) => { for (let k = 0; k < 2; k++) await cycle(p, []); }));
  log(`measuring ${N} cycles`);
  const t0 = performance.now();
  await Promise.all(
    vps.map(async (p) => {
      while (done < N) {
        done++;
        cycles.push(await cycle(p, sink));
      }
    }),
  );
  wallMs = performance.now() - t0;
  samples = sink;
  const byName: Record<string, ReturnType<typeof summarize>> = {};
  for (const name of new Set(sink.map((s) => s.name))) byName[name] = summarize(sink.filter((s) => s.name === name));
  cycles.sort((a, b) => a - b);
  out.perCall = byName;
  out.cycles = { count: cycles.length, perSecond: r1((cycles.length / wallMs) * 1000), p50: r1(pct(cycles, 50)), p99: r1(pct(cycles, 99)), max: r1(cycles[cycles.length - 1] ?? 0) };
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

const main = scenario === "mixed" ? samples : samples.filter((s) => s.name !== "call");
const sum = summarize(main);
console.log(
  JSON.stringify({
    ...out,
    requests: sum.count,
    errors: sum.errors,
    wallMs: r1(wallMs),
    requestsPerSecond: r1((sum.count / wallMs) * 1000),
    latencyMs: { p50: sum.p50, p90: sum.p90, p99: sum.p99, max: sum.max },
  }),
);
