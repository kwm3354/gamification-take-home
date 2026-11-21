import { createHmac } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeCasino } from "../src/fake-casino/server.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { startFake } from "./fake.ts";

// Parsed JSON from the fake, checked field by field in the tests.
// biome-ignore lint/suspicious/noExplicitAny: test helper type
type Json = any;

const alpha = demoTenants[0]!;
const beta = demoTenants[1]!;

interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

let stub: Server;
let received: Received[] = [];
let fake: FakeCasino;

beforeAll(async () => {
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, raw: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  fake = await startFake(stubUrl);
});

afterAll(async () => {
  await fake.close();
  stub.closeAllConnections();
  await new Promise<void>((r) => stub.close(() => r()));
});

beforeEach(async () => {
  received = [];
  await control("/control/reset", {});
});

async function control(path: string, body: unknown) {
  const res = await fetch(fake.url + path, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
}

const fault = (point: string, name: string, extra: object = {}) =>
  control("/control/faults", { point, fault: name, ...extra });

function grantA(reference: string, key = reference, tenant = alpha) {
  return fetch(`${fake.url}/a/bonuses`, {
    method: "POST",
    headers: { authorization: `Bearer ${tenant.platformKey}`, "idempotency-key": key },
    body: JSON.stringify({ player_id: "p-1", amount_minor: 500, currency: "EUR", reference }),
  });
}

const findA = (reference: string) =>
  fetch(`${fake.url}/a/bonuses?reference=${reference}`, {
    headers: { authorization: `Bearer ${alpha.platformKey}` },
  });

function grantB(externalRef: string) {
  return fetch(`${fake.url}/b/v2/rewards/grant`, {
    method: "POST",
    headers: { "x-api-key": beta.platformKey },
    body: JSON.stringify({
      customerId: "77",
      reward: { type: "BONUS", value: "5.00", currency: "EUR" },
      externalRef,
    }),
  });
}

const findB = (externalRef: string) =>
  fetch(`${fake.url}/b/v2/rewards/requests?externalRef=${externalRef}`, {
    headers: { "x-api-key": beta.platformKey },
  });

const state = async () => (await fetch(`${fake.url}/control/state`)).json() as Promise<Json>;
const deliver = () => control("/control/b/deliver", {});

describe("platform A", () => {
  it("grants once per Idempotency-Key and finds the grant by reference", async () => {
    const first = await grantA("red-1");
    expect(first.status).toBe(201);
    const a = (await first.json()) as Json;
    const second = await grantA("red-1", "red-1");
    const b = (await second.json()) as Json;
    expect(b.bonus_id).toBe(a.bonus_id);
    expect((await state()).grants).toHaveLength(1);

    const found = await findA("red-1");
    expect(found.status).toBe(200);
    expect(((await found.json()) as Json).bonus_id).toBe(a.bonus_id);
    expect((await findA("nobody")).status).toBe(404);
  });

  it("a different key with the same reference grants again (only the key protects)", async () => {
    await grantA("red-2", "k1");
    await grantA("red-2", "k2");
    expect((await state()).grants).toHaveLength(2);
  });
});

describe("platform B", () => {
  it("accepts, then grants and sends a signed notice on delivery", async () => {
    const res = await grantB("red-3");
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as Json;
    expect(accepted.state).toBe("ACCEPTED");
    expect((await state()).grants).toHaveLength(0);
    const before = (await (await findB("red-3")).json()) as Json;
    expect(before.items[0].state).toBe("ACCEPTED");

    const delivered = await deliver();
    expect(delivered.body.delivered).toHaveLength(1);
    expect((await state()).grants).toHaveLength(1);
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.url).toBe("/webhooks/beta-casino/rewards");
    const expected = createHmac("sha256", beta.webhookSecret).update(got.raw).digest("base64");
    expect(got.headers["x-beta-auth"]).toBe(expected);
    expect(JSON.parse(got.raw)).toEqual({
      requestId: accepted.requestId,
      externalRef: "red-3",
      state: "GRANTED",
    });
    const after = (await (await findB("red-3")).json()) as Json;
    expect(after.items[0].state).toBe("GRANTED");
  });

  it("two grant calls with one externalRef make two requests and two grants", async () => {
    await grantB("red-4");
    await grantB("red-4");
    const list = (await (await findB("red-4")).json()) as Json;
    expect(list.items).toHaveLength(2);
    await deliver();
    expect((await state()).grants).toHaveLength(2);
  });

  it("refuse gives a DECLINED request, no grant, and a notice with the reason", async () => {
    await fault("b.grant", "refuse");
    await grantB("red-5");
    await deliver();
    expect((await state()).grants).toHaveLength(0);
    expect(JSON.parse(received[0]!.raw)).toMatchObject({ state: "DECLINED", reason: "player_blocked" });
    const list = (await (await findB("red-5")).json()) as Json;
    expect(list.items[0]).toMatchObject({ state: "DECLINED", reason: "player_blocked" });
  });
});

describe("faults at a.grant", () => {
  it("error_500, rate_limit and lost_request leave no grant", async () => {
    await fault("a.grant", "error_500");
    expect((await grantA("f1")).status).toBe(500);
    await fault("a.grant", "rate_limit");
    const limited = await grantA("f2");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    await fault("a.grant", "lost_request");
    await expect(grantA("f3")).rejects.toThrow();
    expect((await state()).grants).toHaveLength(0);
    const log = (await state()).requests.map((r: Json) => r.fault);
    expect(log).toEqual(["error_500", "rate_limit", "lost_request"]);
  });

  it("lost_answer does the work and the client call fails", async () => {
    await fault("a.grant", "lost_answer");
    await expect(grantA("f4")).rejects.toThrow();
    expect((await state()).grants).toHaveLength(1);
    expect((await findA("f4")).status).toBe(200);
  });

  it("slow_answer does the work and answers late", async () => {
    await fault("a.grant", "slow_answer", { delayMs: 50 });
    const res = await grantA("f5");
    expect(res.status).toBe(201);
    expect((await state()).grants).toHaveLength(1);
  });

  it("refuse gives 422 and find reports rejected", async () => {
    await fault("a.grant", "refuse");
    const res = await grantA("f6");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "player_blocked" });
    expect((await state()).grants).toHaveLength(0);
    const found = (await (await findA("f6")).json()) as Json;
    expect(found.status).toBe("rejected");
  });

  it("faults at a.find work too", async () => {
    await fault("a.find", "error_500");
    expect((await findA("x")).status).toBe(500);
    await fault("a.find", "lost_request");
    await expect(findA("x")).rejects.toThrow();
  });

  it("times: 2 applies to exactly two calls", async () => {
    await fault("a.grant", "error_500", { times: 2 });
    expect((await grantA("t1", "t1")).status).toBe(500);
    expect((await grantA("t1", "t1")).status).toBe(500);
    expect((await grantA("t1", "t1")).status).toBe(201);
    expect((await (await fetch(`${fake.url}/control/faults`)).json()) as Json).toEqual([]);
  });

  it("a fault with a tenantId does not touch another tenant", async () => {
    await fault("b.grant", "error_500", { tenantId: "some-other" });
    expect((await grantB("t2")).status).toBe(202);
  });
});

describe("faults at b.callback", () => {
  it("lost: the request is final and nothing is sent", async () => {
    await fault("b.callback", "lost");
    await grantB("c1");
    await deliver();
    expect(received).toHaveLength(0);
    const list = (await (await findB("c1")).json()) as Json;
    expect(list.items[0].state).toBe("GRANTED");
    const s = await state();
    expect(s.grants).toHaveLength(1);
    expect(s.callbacks[0].status).toBe("lost");
  });

  it("twice: the same notice is sent two times", async () => {
    await fault("b.callback", "twice");
    await grantB("c2");
    await deliver();
    expect(received).toHaveLength(2);
    expect(received[0]!.raw).toBe(received[1]!.raw);
    expect((await state()).grants).toHaveLength(1);
  });

  it("delay: skipped by one deliver call, sent by the next", async () => {
    await fault("b.callback", "delay");
    await grantB("c3");
    await deliver();
    expect(received).toHaveLength(0);
    expect((await state()).grants).toHaveLength(0);
    await deliver();
    expect(received).toHaveLength(1);
    expect((await state()).grants).toHaveLength(1);
  });
});

describe("/control/deposit", () => {
  it("platform A: right format, verifiable signature, identical bytes on repeat", async () => {
    const res = await control("/control/deposit", {
      tenantId: alpha.id,
      playerId: "p-100",
      amount: "20.00",
      eventId: "evt_a1",
      repeat: 3,
    });
    expect(res.body.eventId).toBe("evt_a1");
    expect(res.body.sent).toHaveLength(3);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.raw)).size).toBe(1);
    const got = received[0]!;
    expect(got.url).toBe("/webhooks/alpha-casino/events");
    const body = JSON.parse(got.raw);
    expect(body).toMatchObject({
      event_id: "evt_a1",
      type: "deposit.succeeded",
      player_id: "p-100",
      amount_minor: 2000,
      currency: "EUR",
    });
    const ts = got.headers["x-alpha-timestamp"] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(10);
    const expected = createHmac("sha256", alpha.webhookSecret).update(`${ts}.${got.raw}`).digest("hex");
    expect(got.headers["x-alpha-signature"]).toBe(expected);
  });

  it("platform B: right format and base64 signature", async () => {
    await control("/control/deposit", { tenantId: beta.id, playerId: "77", amount: "20.00", eventId: "T-1" });
    const got = received[0]!;
    expect(got.url).toBe("/webhooks/beta-casino/events");
    const body = JSON.parse(got.raw);
    expect(body.transactions[0]).toMatchObject({
      txnId: "T-1",
      kind: "DEPOSIT",
      state: "COMPLETED",
      customer: { id: "77" },
      amount: "20.00",
      currencyCode: "EUR",
    });
    const expected = createHmac("sha256", beta.webhookSecret).update(got.raw).digest("base64");
    expect(got.headers["x-beta-auth"]).toBe(expected);
  });

  it("tamper variants break exactly what they say", async () => {
    await control("/control/deposit", {
      tenantId: alpha.id,
      playerId: "p",
      amount: "1.00",
      tamper: "signature",
    });
    await control("/control/deposit", {
      tenantId: beta.id,
      playerId: "p",
      amount: "1.00",
      tamper: "signature",
    });
    const [a, b] = received;
    const goodA = createHmac("sha256", alpha.webhookSecret)
      .update(`${a!.headers["x-alpha-timestamp"]}.${a!.raw}`)
      .digest("hex");
    expect(a!.headers["x-alpha-signature"]).not.toBe(goodA);
    const goodB = createHmac("sha256", beta.webhookSecret).update(b!.raw).digest("base64");
    expect(b!.headers["x-beta-auth"]).not.toBe(goodB);

    received = [];
    await control("/control/deposit", { tenantId: alpha.id, playerId: "p", amount: "1.00", tamper: "stale" });
    const stale = received[0]!;
    const ts = Number(stale.headers["x-alpha-timestamp"]);
    expect(Date.now() / 1000 - ts).toBeGreaterThan(3500);
    const sig = createHmac("sha256", alpha.webhookSecret).update(`${ts}.${stale.raw}`).digest("hex");
    expect(stale.headers["x-alpha-signature"]).toBe(sig);

    received = [];
    await control("/control/deposit", {
      tenantId: alpha.id,
      playerId: "p",
      amount: "1.00",
      tamper: "failed",
    });
    await control("/control/deposit", { tenantId: beta.id, playerId: "p", amount: "1.00", tamper: "failed" });
    expect(JSON.parse(received[0]!.raw).type).toBe("deposit.failed");
    expect(JSON.parse(received[1]!.raw).transactions[0].state).toBe("FAILED");
  });

  it("ourUrl replaces the default target and our answer is returned", async () => {
    const res = await control("/control/deposit", {
      tenantId: alpha.id,
      playerId: "p",
      amount: "1.00",
      ourUrl: "http://127.0.0.1:1",
    });
    expect(res.status).toBe(200);
    expect(res.body.sent[0].status).toBe(0);
    expect(received).toHaveLength(0);
  });
});

describe("/control/token", () => {
  const decode = (token: string) => {
    const [h, p, s] = token.split(".") as [string, string, string];
    return {
      h,
      p,
      s,
      header: JSON.parse(Buffer.from(h, "base64url").toString()),
      claims: JSON.parse(Buffer.from(p, "base64url").toString()),
    };
  };
  const sign = (t: { h: string; p: string }, secret: string) =>
    createHmac("sha256", secret).update(`${t.h}.${t.p}`).digest("base64url");

  it("makes a valid HS256 token", async () => {
    const { body } = await control("/control/token", { tenantId: beta.id, playerId: "77" });
    const t = decode(body.token);
    expect(t.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(t.s).toBe(sign(t, beta.tokenSecret));
    expect(t.claims.iss).toBe("beta-casino");
    expect(t.claims.sub).toBe("77");
    expect(t.claims.exp - t.claims.iat).toBe(600);
  });

  it("tamper signature uses a wrong secret; tamper expired is in the past", async () => {
    const wrong = decode(
      (await control("/control/token", { tenantId: beta.id, playerId: "77", tamper: "signature" })).body
        .token,
    );
    expect(wrong.s).not.toBe(sign(wrong, beta.tokenSecret));
    const old = decode(
      (await control("/control/token", { tenantId: beta.id, playerId: "77", tamper: "expired" })).body.token,
    );
    expect(old.s).toBe(sign(old, beta.tokenSecret));
    expect(old.claims.exp).toBeLessThan(Date.now() / 1000);
  });
});

describe("chaos", () => {
  async function run(seed: number): Promise<string[]> {
    await control("/control/reset", {});
    await control("/control/chaos", {
      seed,
      rates: { "a.grant": { error_500: 0.25, rate_limit: 0.2, lost_request: 0.2 } },
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 30; i++) {
      try {
        outcomes.push(String((await grantA(`ch-${i}`)).status));
      } catch {
        outcomes.push("dropped");
      }
    }
    return outcomes;
  }

  it("the same seed gives the same outcomes; another seed gives other ones", async () => {
    const one = await run(7);
    const two = await run(7);
    const other = await run(8);
    expect(two).toEqual(one);
    expect(other).not.toEqual(one);
    expect(new Set(one).size).toBeGreaterThan(1);
  });

  it("scripted faults win over chaos, and seed null turns chaos off", async () => {
    await control("/control/chaos", { seed: 1, rates: { "a.grant": { error_500: 1 } } });
    expect((await grantA("w1")).status).toBe(500);
    await fault("a.grant", "refuse");
    expect((await grantA("w2")).status).toBe(422);
    await control("/control/chaos", { seed: null });
    expect((await grantA("w3")).status).toBe(201);
  });
});

describe("bad input", () => {
  it("wrong key is 401, wrong platform is 404", async () => {
    const bad = await fetch(`${fake.url}/a/bonuses?reference=x`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
    const none = await fetch(`${fake.url}/b/v2/rewards/requests?externalRef=x`);
    expect(none.status).toBe(401);
    expect((await grantA("x", "x", beta)).status).toBe(404);
    const other = await fetch(`${fake.url}/b/v2/rewards/requests?externalRef=x`, {
      headers: { "x-api-key": alpha.platformKey },
    });
    expect(other.status).toBe(404);
  });

  it("invalid JSON and missing fields are 400 and the server keeps working", async () => {
    const broken = await fetch(`${fake.url}/a/bonuses`, {
      method: "POST",
      headers: { authorization: `Bearer ${alpha.platformKey}`, "idempotency-key": "k" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    const noKey = await fetch(`${fake.url}/a/bonuses`, {
      method: "POST",
      headers: { authorization: `Bearer ${alpha.platformKey}` },
      body: JSON.stringify({ player_id: "p", amount_minor: 1, currency: "EUR", reference: "r" }),
    });
    expect(noKey.status).toBe(400);
    expect(
      (await control("/control/deposit", { tenantId: "nobody", playerId: "p", amount: "1.00" })).status,
    ).toBe(400);
    expect((await control("/control/faults", { point: "a.grant", fault: "lost" })).status).toBe(400);
    expect((await control("/control/deposit", { tenantId: alpha.id })).status).toBe(400);
    expect((await state()).grants).toEqual([]);
  });

  it("reset empties the state and the fault queue", async () => {
    await grantA("z1");
    await fault("a.grant", "error_500");
    await control("/control/reset", {});
    const s = await state();
    expect(s).toEqual({ grants: [], requests: [], callbacks: [] });
    expect((await (await fetch(`${fake.url}/control/faults`)).json()) as Json).toEqual([]);
  });

  it("answers CORS and OPTIONS, and GET / serves the playground page", async () => {
    const pre = await fetch(`${fake.url}/control/state`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const page = await fetch(`${fake.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
  });
});
