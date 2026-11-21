import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { startApp } from "./app.ts";
import { alphaDeposit, betaTxn, playerToken, signAlpha, signBeta, tokenFor } from "./signing.ts";

// Real HTTP against the whole app and a real PostgreSQL. Skipped when no TigerBeetle is available.
const running = await startApp();
const tenantNamed = (id: string) => {
  const t = demoTenants.find((d) => d.id === id);
  if (!t) throw new Error(`no demo tenant ${id}`);
  return t;
};
const alpha = tenantNamed("alpha-casino");
const beta = tenantNamed("beta-casino");

beforeAll(async () => {
  if (running) await seedDemo(running.db, running.clock, "http://127.0.0.1:1");
});
afterAll(() => running?.close());

const app = () => {
  if (!running) throw new Error("no app");
  return running;
};
const now = () => app().clock.now().getTime();

async function postAlpha(body: string, headers = signAlpha(alpha.webhookSecret, body, now())) {
  const r = await fetch(`${app().url}/webhooks/alpha-casino/events`, { method: "POST", headers, body });
  return { status: r.status, json: (await r.json()) as Record<string, number> };
}
async function postBeta(payload: unknown, tenantPath = "beta-casino", secret = beta.webhookSecret) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = await fetch(`${app().url}/webhooks/${tenantPath}/events`, {
    method: "POST",
    headers: signBeta(secret, body),
    body,
  });
  return { status: r.status, json: (await r.json()) as Record<string, number> };
}
async function me(token?: string) {
  const r = await fetch(`${app().url}/me`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return {
    status: r.status,
    json: (await r.json()) as { playerId: string; tenantId: string; spins: unknown[] },
  };
}
async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const r = await app().db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return r.rows[0].n;
}
const alphaToken = (sub: string) => tokenFor("alpha-casino", alpha.tokenSecret, sub, now());

describe.skipIf(!running)("deposit intake", () => {
  test("1. platform A happy path: one player, one event, one available spin, visible in /me", async () => {
    const res = await postAlpha(alphaDeposit("evt-happy", "p-happy"));
    expect(res).toEqual({ status: 200, json: { accepted: 1, duplicates: 0, ignored: 0 } });
    expect(await count("players", "external_id = 'p-happy'")).toBe(1);
    expect(await count("inbound_events", "external_event_id = 'evt-happy'")).toBe(1);
    const mine = await me(alphaToken("p-happy"));
    expect(mine.status).toBe(200);
    expect(mine.json.tenantId).toBe("alpha-casino");
    expect(mine.json.spins).toHaveLength(1);
    expect(mine.json.spins[0]).toMatchObject({ status: "available", coins: null });
  });

  test("2. the same deposit twice in a row: duplicate, still one spin", async () => {
    const body = alphaDeposit("evt-twice", "p-twice");
    await postAlpha(body);
    const second = await postAlpha(body);
    expect(second.json).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    expect((await me(alphaToken("p-twice"))).json.spins).toHaveLength(1);
  });

  test("3. ten identical deposits at once: exactly one spin", async () => {
    const body = alphaDeposit("evt-race", "p-race");
    const answers = await Promise.all(Array.from({ length: 10 }, () => postAlpha(body)));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(answers.reduce((sum, a) => sum + (a.json.accepted ?? 0), 0)).toBe(1);
    expect(await count("spins s JOIN players p ON p.id = s.player_id", "p.external_id = 'p-race'")).toBe(1);
  });

  test("4. platform B batch: one deposit accepted, two ignored; 20.00 is 2000 minor units; repeat is all duplicates", async () => {
    const batch = {
      batchId: "batch-1",
      transactions: [
        betaTxn("T-ok", "b-1"),
        betaTxn("T-failed", "b-1", { state: "FAILED" }),
        betaTxn("T-withdraw", "b-1", { kind: "WITHDRAWAL" }),
      ],
    };
    expect(await postBeta(batch)).toEqual({ status: 200, json: { accepted: 1, duplicates: 0, ignored: 2 } });
    const ev = await app().db.query(
      "SELECT normalized FROM inbound_events WHERE tenant_id = 'beta-casino' AND external_event_id = 'T-ok'",
    );
    expect(ev.rows[0].normalized.amountMinor).toBe(2000);
    expect(
      await count("inbound_events", "tenant_id = 'beta-casino' AND kind = 'ignored' AND player_id IS NULL"),
    ).toBe(2);
    expect((await postBeta(batch)).json).toEqual({ accepted: 0, duplicates: 3, ignored: 0 });
    expect(await count("spins", "tenant_id = 'beta-casino'")).toBe(1);
  });

  test("4b. one id reported as pending and then as completed gives one spin, on both platforms, in any order", async () => {
    const alphaEvent = (type: string) =>
      JSON.stringify({ ...JSON.parse(alphaDeposit("evt-pend", "p-pend")), type });
    expect((await postAlpha(alphaEvent("deposit.pending"))).json).toEqual({
      accepted: 0,
      duplicates: 0,
      ignored: 1,
    });
    expect((await postAlpha(alphaEvent("deposit.pending"))).json).toEqual({
      accepted: 0,
      duplicates: 1,
      ignored: 0,
    });
    expect((await postAlpha(alphaEvent("deposit.succeeded"))).json).toEqual({
      accepted: 1,
      duplicates: 0,
      ignored: 0,
    });
    expect((await postAlpha(alphaEvent("deposit.succeeded"))).json).toEqual({
      accepted: 0,
      duplicates: 1,
      ignored: 0,
    });
    expect((await me(alphaToken("p-pend"))).json.spins).toHaveLength(1);
    // Out of order: completed first, then pending. No change.
    const ok = await postAlpha(
      alphaEvent("deposit.succeeded").replace("evt-pend", "evt-late").replace("p-pend", "p-late"),
    );
    expect(ok.json.accepted).toBe(1);
    const late = alphaEvent("deposit.pending").replace("evt-pend", "evt-late").replace("p-pend", "p-late");
    expect((await postAlpha(late)).json.accepted).toBe(0);
    expect((await me(alphaToken("p-late"))).json.spins).toHaveLength(1);

    const pendingB = { transactions: [betaTxn("T-pend", "b-pend", { state: "PENDING" })] };
    const doneB = { transactions: [betaTxn("T-pend", "b-pend")] };
    expect((await postBeta(pendingB)).json).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
    expect((await postBeta(pendingB)).json).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    expect((await postBeta(doneB)).json).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    expect((await postBeta(doneB)).json).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    expect(await count("spins s JOIN players p ON p.id = s.player_id", "p.external_id = 'b-pend'")).toBe(1);
    const lateB = {
      transactions: [betaTxn("T-late", "b-late"), betaTxn("T-late", "b-late", { state: "PENDING" })],
    };
    expect((await postBeta(lateB)).json.accepted).toBe(1);
    expect(await count("spins s JOIN players p ON p.id = s.player_id", "p.external_id = 'b-late'")).toBe(1);
  });

  test("4c. a timestamp out of the date range is a 400 with a webhook_invalid audit row, on both platforms", async () => {
    const before = await count("audit_log", "action = 'webhook_invalid'");
    const huge = await postBeta({ transactions: [betaTxn("T-huge", "b-huge", { completedAt: 1e20 })] });
    expect(huge.status).toBe(400);
    const farA = alphaDeposit("evt-far", "p-far").replace("2026-11-21T08:00:00Z", "+275760-09-14T00:00:00Z");
    expect((await postAlpha(farA)).status).toBe(400);
    expect(await count("audit_log", "action = 'webhook_invalid'")).toBe(before + 2);
    expect(await count("inbound_events", "external_event_id IN ('T-huge', 'evt-far')")).toBe(0);
  });

  test("4d. ids longer than 200 characters: 400 on both platforms, nothing stored; a token with a long sub is 401", async () => {
    const long = "x".repeat(201);
    const players = await count("players");
    const events = await count("inbound_events");
    expect((await postAlpha(alphaDeposit("evt-long", long))).status).toBe(400);
    expect((await postAlpha(alphaDeposit(long, "p-long"))).status).toBe(400);
    expect((await postBeta({ transactions: [betaTxn("T-long", long)] })).status).toBe(400);
    expect((await postBeta({ transactions: [betaTxn(long, "b-long")] })).status).toBe(400);
    expect(await count("players")).toBe(players);
    expect(await count("inbound_events")).toBe(events);
    expect((await me(alphaToken(long))).status).toBe(401);
    expect((await me(alphaToken("x".repeat(200)))).status).toBe(200);
  });

  test("5. bad signature on A and B: 401, nothing stored, one webhook_rejected audit row each", async () => {
    const before = {
      players: await count("players"),
      events: await count("inbound_events"),
      spins: await count("spins"),
      rejected: await count("audit_log", "action = 'webhook_rejected'"),
    };
    const body = alphaDeposit("evt-bad", "p-bad");
    const a = await postAlpha(body, signAlpha("wrong-secret", body, now()));
    const b = await postBeta({ transactions: [betaTxn("T-bad", "b-bad")] }, "beta-casino", "wrong-secret");
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await count("players")).toBe(before.players);
    expect(await count("inbound_events")).toBe(before.events);
    expect(await count("spins")).toBe(before.spins);
    expect(await count("audit_log", "action = 'webhook_rejected'")).toBe(before.rejected + 2);
    const row = await app().db.query(
      "SELECT actor, changes FROM audit_log WHERE action = 'webhook_rejected' ORDER BY id DESC LIMIT 1",
    );
    expect(row.rows[0].actor).toBe("unknown");
    expect(JSON.stringify(row.rows[0].changes)).not.toContain("T-bad"); // the body is not stored
  });

  test("6. A: stale timestamp and an altered body are rejected", async () => {
    const body = alphaDeposit("evt-stale", "p-stale");
    expect((await postAlpha(body, signAlpha(alpha.webhookSecret, body, now(), -301))).status).toBe(401);
    expect((await postAlpha(body, signAlpha(alpha.webhookSecret, body, now(), -299))).status).toBe(200);
    const signed = signAlpha(alpha.webhookSecret, alphaDeposit("evt-alter", "p-alter", 2000), now());
    const altered = await postAlpha(alphaDeposit("evt-alter", "p-alter", 999999), signed);
    expect(altered.status).toBe(401);
    expect(await count("inbound_events", "external_event_id = 'evt-alter'")).toBe(0);
  });

  test("7. signed but invalid payloads are 400 and store nothing", async () => {
    const noPlayer = JSON.stringify({
      event_id: "evt-np",
      type: "deposit.succeeded",
      amount_minor: 5,
      currency: "EUR",
      occurred_at: "2026-11-21T08:00:00Z",
    });
    expect((await postAlpha(noPlayer)).status).toBe(400);
    expect((await postBeta({ transactions: [betaTxn("T-3dec", "b-7", { amount: "20.001" })] })).status).toBe(
      400,
    );
    const mixed = { transactions: [betaTxn("T-good", "b-7"), betaTxn("T-badone", "b-7", { amount: "abc" })] };
    expect((await postBeta(mixed)).status).toBe(400);
    expect(
      await count("inbound_events", "external_event_id IN ('evt-np', 'T-3dec', 'T-good', 'T-badone')"),
    ).toBe(0);
    expect(await count("audit_log", "action = 'webhook_invalid'")).toBeGreaterThanOrEqual(3);
  });

  test("8. unknown tenant is 404", async () => {
    const r = await postBeta({ transactions: [betaTxn("T-x", "b-x")] }, "nobody-casino");
    expect(r.status).toBe(404);
  });

  test("9. tenants are isolated", async () => {
    const body = alphaDeposit("evt-iso", "p-1");
    const wrongTenant = await fetch(`${app().url}/webhooks/beta-casino/events`, {
      method: "POST",
      headers: signAlpha(alpha.webhookSecret, body, now()),
      body,
    });
    expect(wrongTenant.status).toBe(401);

    await postAlpha(alphaDeposit("evt-iso-a", "p-1"));
    await postBeta({ transactions: [betaTxn("T-iso-b", "p-1"), betaTxn("T-iso-b2", "p-1")] });
    expect(await count("players", "external_id = 'p-1'")).toBe(2);
    const a = await me(alphaToken("p-1"));
    expect(a.json.spins).toHaveLength(1);
    const b = await me(tokenFor("beta-casino", beta.tokenSecret, "p-1", now()));
    expect(b.json.spins).toHaveLength(2);
    expect(b.json.tenantId).toBe("beta-casino");
    const forged = tokenFor("alpha-casino", beta.tokenSecret, "p-1", now());
    expect((await me(forged)).status).toBe(401);
  });

  test("10. bad tokens are 401, and a token stops working when the clock passes exp", async () => {
    const t = now();
    const exp = Math.floor(t / 1000);
    const base = { iss: "alpha-casino", sub: "p-tok", exp: exp + 600 };
    const secret = alpha.tokenSecret;
    const bad = [
      undefined,
      "garbage",
      "a.b.c",
      playerToken(secret, { ...base, exp: exp - 10 }),
      playerToken(secret, { ...base, exp: exp + 7200 }),
      playerToken(secret, base, { alg: "none" }),
      playerToken(secret, { ...base, sub: "" }),
      playerToken(secret, { iss: "alpha-casino", sub: "p-tok" }),
      playerToken(secret, { ...base, iss: "nobody" }),
    ];
    for (const token of bad) expect((await me(token)).status).toBe(401);
    const unsigned = `${playerToken(secret, base).split(".").slice(0, 2).join(".")}.`;
    expect((await me(unsigned)).status).toBe(401);

    const token = tokenFor("alpha-casino", secret, "p-tok", t, 600);
    expect((await me(token)).status).toBe(200);
    app().clock.advance(11 * 60_000);
    expect((await me(token)).status).toBe(401);
  });

  test("11. first deposits of one new player at once, in both tenants: no error, one player row each", async () => {
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      jobs.push(postAlpha(alphaDeposit(`evt-new-a${i}`, "p-new")));
      jobs.push(postBeta({ transactions: [betaTxn(`T-new-b${i}`, "p-new")] }));
    }
    const answers = await Promise.all(jobs);
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(await count("players", "external_id = 'p-new' AND tenant_id = 'alpha-casino'")).toBe(1);
    expect(await count("players", "external_id = 'p-new' AND tenant_id = 'beta-casino'")).toBe(1);
    expect(await count("spins s JOIN players p ON p.id = s.player_id", "p.external_id = 'p-new'")).toBe(8);
  });
});
