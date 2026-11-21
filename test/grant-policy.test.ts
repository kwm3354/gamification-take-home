import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { create } from "../src/audit/audited.ts";
import { transaction } from "../src/db.ts";
import type { DepositSucceeded } from "../src/domain/casino-platform.ts";
import { type GrantParams, spinsForDeposit, validateGrantParams } from "../src/policies/grant-policy.ts";
import { demoTenants } from "../src/tenants/demo-tenants.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { startApp } from "./app.ts";
import { startFake } from "./fake.ts";

const dep = (amountMinor: number, currency = "EUR"): DepositSucceeded => ({
  kind: "deposit_succeeded",
  externalEventId: "e",
  externalPlayerId: "p",
  amountMinor,
  currency,
  occurredAt: "2026-11-21T08:00:00Z",
});
const params = (over: Partial<GrantParams> = {}): GrantParams => ({
  minAmountMinor: 1,
  currencies: null,
  spinsPerDeposit: 1,
  ...over,
});

describe("spinsForDeposit", () => {
  const rows: [string, DepositSucceeded, GrantParams, unknown][] = [
    ["default policy", dep(2000), params(), { spins: 1 }],
    ["exactly the minimum", dep(5000), params({ minAmountMinor: 5000 }), { spins: 1 }],
    [
      "one below the minimum",
      dep(4999),
      params({ minAmountMinor: 5000 }),
      { spins: 0, reason: "below_minimum" },
    ],
    ["zero minimum, zero amount", dep(0), params({ minAmountMinor: 0 }), { spins: 1 }],
    ["currency in the list", dep(2000, "EUR"), params({ currencies: ["EUR", "GBP"] }), { spins: 1 }],
    [
      "currency not in the list",
      dep(2000, "USD"),
      params({ currencies: ["EUR"] }),
      { spins: 0, reason: "currency_not_allowed" },
    ],
    ["two spins", dep(2000), params({ spinsPerDeposit: 2 }), { spins: 2 }],
    ["zero spins configured", dep(2000), params({ spinsPerDeposit: 0 }), { spins: 0, reason: "zero_spins" }],
    [
      "the minimum is checked before the currency",
      dep(10, "USD"),
      params({ minAmountMinor: 100, currencies: ["EUR"] }),
      { spins: 0, reason: "below_minimum" },
    ],
  ];
  test.each(rows)("%s", (_name, deposit, p, expected) => {
    expect(spinsForDeposit(deposit, p)).toEqual(expected);
  });
});

describe("validateGrantParams", () => {
  const good = { minAmountMinor: 0, currencies: null, spinsPerDeposit: 10 };
  test("accepts good params", () => {
    expect(validateGrantParams(good)).toEqual(good);
    expect(validateGrantParams({ ...good, currencies: ["EUR", "USD"], spinsPerDeposit: 0 })).toBeTruthy();
  });
  const bad: [string, unknown][] = [
    ["not an object", 5],
    ["null", null],
    ["negative minimum", { ...good, minAmountMinor: -1 }],
    ["fractional minimum", { ...good, minAmountMinor: 1.5 }],
    ["string minimum", { ...good, minAmountMinor: "5" }],
    ["too many spins", { ...good, spinsPerDeposit: 11 }],
    ["negative spins", { ...good, spinsPerDeposit: -1 }],
    ["fractional spins", { ...good, spinsPerDeposit: 1.5 }],
    ["empty currency list", { ...good, currencies: [] }],
    ["bad currency code", { ...good, currencies: ["EURO"] }],
    ["lower-case currency code", { ...good, currencies: ["eur"] }],
    ["currencies missing", { minAmountMinor: 0, spinsPerDeposit: 1 }],
    ["spins missing", { minAmountMinor: 0, currencies: null }],
  ];
  test.each(bad)("refuses %s", (_name, value) => {
    expect(() => validateGrantParams(value)).toThrow();
  });
});

// The whole app, in order: each test may add a policy version for a tenant, and later tests see it.
const running = await startApp();
const fake = running ? await startFake(running.url) : undefined;
const alpha = demoTenants.find((t) => t.id === "alpha-casino");
const beta = demoTenants.find((t) => t.id === "beta-casino");
if (!alpha || !beta) throw new Error("demo tenants missing");

beforeAll(async () => {
  if (running) await seedDemo(running.db, running.clock, "http://127.0.0.1:1");
});
afterAll(async () => {
  await running?.close();
  await fake?.close();
});

const app = () => {
  if (!running || !fake) throw new Error("no app");
  return running;
};

async function addPolicy(tenantId: string, version: number, p: GrantParams): Promise<string> {
  const row = await transaction(app().db, (tx) =>
    create(tx, { tenantId, actor: "admin/test", now: app().clock.now() }, "grant_policies", {
      tenant_id: tenantId,
      version,
      params: p,
    }),
  );
  return row?.id as string;
}

async function deposit(
  tenantId: string,
  playerId: string,
  amount: string,
  currency = "EUR",
  eventId?: string,
) {
  const r = await fetch(`${fake?.url}/control/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId, playerId, amount, currency, eventId: eventId ?? `evt-${randomUUID()}` }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as {
    eventId: string;
    sent: { status: number; body: Record<string, number> }[];
  };
  expect(body.sent[0]?.status).toBe(200);
  return { eventId: body.eventId, answer: body.sent[0]?.body as Record<string, number> };
}

const spinsOf = async (tenantId: string, external: string) =>
  (
    await app().db.query(
      `SELECT s.id, s.ordinal, s.grant_policy_id FROM spins s JOIN players p ON p.id = s.player_id
       WHERE p.tenant_id = $1 AND p.external_id = $2 ORDER BY s.ordinal, s.created_at`,
      [tenantId, external],
    )
  ).rows;

describe.skipIf(!running)("grant policy over HTTP", () => {
  const player = () => `p-${randomUUID()}`;
  let alphaV1: string;
  let betaV1: string;
  const oldPlayer = player();

  test("version 1 is seeded for both tenants and used for the first spin", async () => {
    const policies = await app().db.query("SELECT id, tenant_id, version, params FROM grant_policies");
    expect(policies.rows).toHaveLength(2);
    for (const r of policies.rows) {
      expect(r.version).toBe(1);
      expect(r.params).toEqual({ minAmountMinor: 1, currencies: null, spinsPerDeposit: 1 });
      if (r.tenant_id === alpha.id) alphaV1 = r.id;
      else betaV1 = r.id;
    }
    await deposit(alpha.id, oldPlayer, "20.00");
    const spins = await spinsOf(alpha.id, oldPlayer);
    expect(spins).toHaveLength(1);
    expect(spins[0]).toMatchObject({ ordinal: 1, grant_policy_id: alphaV1 });
  });

  test("minimum amount: a 20.00 deposit gives no spin and an audit record; 50.00 gives one", async () => {
    await addPolicy(alpha.id, 2, params({ minAmountMinor: 5000 }));
    const p = player();
    const small = await deposit(alpha.id, p, "20.00");
    expect(small.answer).toEqual({ accepted: 1, duplicates: 0, ignored: 0 });
    expect(await spinsOf(alpha.id, p)).toHaveLength(0);
    const event = await app().db.query(
      "SELECT id FROM inbound_events WHERE tenant_id = $1 AND external_event_id = $2",
      [alpha.id, small.eventId],
    );
    expect(event.rows).toHaveLength(1);
    const audit = await app().db.query(
      "SELECT actor, entity_type, changes FROM audit_log WHERE action = 'spin_not_granted' AND entity_id = $1",
      [event.rows[0].id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].entity_type).toBe("inbound_event");
    expect(audit.rows[0].actor).toBe("platform/alpha-casino");
    expect(audit.rows[0].changes).toMatchObject({ reason: "below_minimum" });
    expect(audit.rows[0].changes.grantPolicyId).toBeTruthy();

    // The same small deposit again is a duplicate and writes no second record.
    const again = await deposit(alpha.id, p, "20.00", "EUR", small.eventId);
    expect(again.answer).toEqual({ accepted: 0, duplicates: 1, ignored: 0 });
    const count = await app().db.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'spin_not_granted' AND entity_id = $1",
      [event.rows[0].id],
    );
    expect(count.rows[0].n).toBe(1);

    await deposit(alpha.id, p, "50.00");
    expect(await spinsOf(alpha.id, p)).toHaveLength(1);
  });

  test("the other tenant is unaffected by that policy", async () => {
    const p = player();
    await deposit(beta.id, p, "20.00");
    const spins = await spinsOf(beta.id, p);
    expect(spins).toHaveLength(1);
    expect(spins[0].grant_policy_id).toBe(betaV1);
  });

  test("two spins per deposit: ordinals 1 and 2, different ids, a repeat adds none", async () => {
    await addPolicy(alpha.id, 3, params({ spinsPerDeposit: 2 }));
    const p = player();
    const first = await deposit(alpha.id, p, "20.00");
    expect(first.answer.accepted).toBe(1);
    const spins = await spinsOf(alpha.id, p);
    expect(spins.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(spins[0].id).not.toBe(spins[1].id);
    const again = await deposit(alpha.id, p, "20.00", "EUR", first.eventId);
    expect(again.answer.duplicates).toBe(1);
    expect(await spinsOf(alpha.id, p)).toHaveLength(2);
  });

  test("currencies: a USD deposit gives none when only EUR counts", async () => {
    await addPolicy(alpha.id, 4, params({ currencies: ["EUR"] }));
    const p = player();
    await deposit(alpha.id, p, "20.00", "USD");
    expect(await spinsOf(alpha.id, p)).toHaveLength(0);
    const reason = await app().db.query(
      "SELECT changes FROM audit_log WHERE action = 'spin_not_granted' ORDER BY id DESC LIMIT 1",
    );
    expect(reason.rows[0].changes.reason).toBe("currency_not_allowed");
    await deposit(alpha.id, p, "20.00", "EUR");
    expect(await spinsOf(alpha.id, p)).toHaveLength(1);
  });

  test("a spin granted under version 1 keeps version 1; new ones use the newest version", async () => {
    const old = await spinsOf(alpha.id, oldPlayer);
    expect(old).toHaveLength(1);
    expect(old[0].grant_policy_id).toBe(alphaV1);
    const p = player();
    await deposit(alpha.id, p, "20.00");
    const newest = await app().db.query(
      "SELECT id FROM grant_policies WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1",
      [alpha.id],
    );
    expect((await spinsOf(alpha.id, p))[0].grant_policy_id).toBe(newest.rows[0].id);
    expect(newest.rows[0].id).not.toBe(alphaV1);
  });

  test("policies cannot be edited or deleted", async () => {
    await expect(app().db.query("UPDATE grant_policies SET version = 99")).rejects.toThrow(/append-only/);
    await expect(app().db.query("DELETE FROM grant_policies")).rejects.toThrow(/append-only/);
  });
});
