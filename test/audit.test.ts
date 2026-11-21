import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AuditContext, create, record, remove, update } from "../src/audit/audited.ts";
import { FakeClock } from "../src/clock.ts";
import { type Db, transaction } from "../src/db.ts";
import { seedDemo } from "../src/tenants/seed.ts";
import { freshDb } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
const clock = new FakeClock("2026-11-21T08:00:00Z");
const ctx = (): AuditContext => ({
  tenantId: "alpha-casino",
  actor: "system/test",
  requestId: "req-1",
  now: clock.now(),
});

beforeAll(async () => {
  ({ db, close } = await freshDb());
  await seedDemo(db, clock, "http://127.0.0.1:1");
});
afterAll(() => close());

const auditRows = async (entityId: string) =>
  (await db.query("SELECT * FROM audit_log WHERE entity_id = $1 ORDER BY id", [entityId])).rows;

async function newSpin(): Promise<string> {
  return transaction(db, async (tx) => {
    const player = await create(tx, ctx(), "players", {
      tenant_id: "alpha-casino",
      external_id: `p-${Math.random()}`,
    });
    const event = await create(tx, ctx(), "inbound_events", {
      tenant_id: "alpha-casino",
      external_event_id: `e-${Math.random()}`,
      kind: "deposit_succeeded",
      player_id: player?.id,
      normalized: { a: 1 },
      raw: { a: 1 },
      received_at: clock.now(),
    });
    const wheel = await tx.query("SELECT id FROM wheel_configs WHERE tenant_id = 'alpha-casino'");
    const spin = await create(tx, ctx(), "spins", {
      tenant_id: "alpha-casino",
      player_id: player?.id,
      source_event_id: event?.id,
      wheel_config_id: wheel.rows[0].id,
    });
    return String(spin?.id);
  });
}

const useSpin = (id: string, coins: number) =>
  transaction(db, (tx) =>
    update(tx, ctx(), "spins", id, (s) => (s.status === "available" ? { status: "used", coins } : null)),
  );

describe("audited writes", () => {
  test("create writes one audit row with every column", async () => {
    const id = await newSpin();
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "create",
      entity_type: "spins",
      actor: "system/test",
      request_id: "req-1",
    });
    const fields = rows[0].changes.map((c: { field: string }) => c.field).sort();
    expect(fields).toEqual(
      [
        "id",
        "tenant_id",
        "player_id",
        "source_event_id",
        "ordinal",
        "wheel_config_id",
        "grant_policy_id",
        "status",
        "segment_index",
        "coins",
        "used_at",
        "credited_at",
        "created_at",
      ].sort(),
    );
    expect(rows[0].changes.find((c: { field: string }) => c.field === "status")).toEqual({
      field: "status",
      from: null,
      to: "available",
    });
  });

  test("update writes only the changed fields and returns before and after", async () => {
    const id = await newSpin();
    const result = await useSpin(id, 50);
    expect(result?.before.status).toBe("available");
    expect(result?.after.status).toBe("used");
    const rows = await auditRows(id);
    expect(rows).toHaveLength(2);
    expect(rows[1].action).toBe("update");
    expect(rows[1].changes).toEqual([
      { field: "status", from: "available", to: "used" },
      { field: "coins", from: null, to: "50" },
    ]);
  });

  test("update that changes nothing, or whose change returns null, writes nothing", async () => {
    const id = await newSpin();
    expect(await transaction(db, (tx) => update(tx, ctx(), "spins", id, () => null))).toBeNull();
    expect(
      await transaction(db, (tx) => update(tx, ctx(), "spins", id, () => ({ status: "available" }))),
    ).toBeNull();
    expect(
      await transaction(db, (tx) =>
        update(tx, ctx(), "spins", "00000000-0000-0000-0000-000000000000", () => ({})),
      ),
    ).toBeNull();
    expect(await auditRows(id)).toHaveLength(1);
  });

  test("two concurrent updates available -> used: exactly one wins", async () => {
    const id = await newSpin();
    // The first transaction holds the lock while the second one starts and has to wait.
    const first = await db.connect();
    await first.query("BEGIN");
    const won = await update(first, ctx(), "spins", id, (s) =>
      s.status === "available" ? { status: "used", coins: 10 } : null,
    );
    const second = useSpin(id, 500);
    await new Promise<void>((resolve) => {
      // Wait until the second transaction is really blocked on the row lock.
      const poll = async () => {
        const r = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%spins%'",
        );
        if (r.rowCount) resolve();
        else setImmediate(poll);
      };
      void poll();
    });
    await first.query("COMMIT");
    first.release();
    const lost = await second;
    expect(won).not.toBeNull();
    expect(lost).toBeNull();
    const row = await db.query("SELECT coins FROM spins WHERE id = $1", [id]);
    expect(row.rows[0].coins).toBe("10");
    expect((await auditRows(id)).filter((r) => r.action === "update")).toHaveLength(1);
  });

  test("remove writes the old values", async () => {
    const id = await transaction(db, async (tx) => {
      const item = await create(tx, ctx(), "store_items", {
        tenant_id: "alpha-casino",
        code: "temp",
        name: "Temp",
        cost_coins: 7,
        reward: { type: "bonus" },
      });
      return String(item?.id);
    });
    await transaction(db, (tx) => remove(tx, ctx(), "store_items", id));
    const rows = await auditRows(id);
    expect(rows.map((r) => r.action)).toEqual(["create", "delete"]);
    expect(rows[1].changes.find((c: { field: string }) => c.field === "code")).toEqual({
      field: "code",
      from: "temp",
      to: null,
    });
    await transaction(db, (tx) => remove(tx, ctx(), "store_items", id)); // nothing to delete
    expect(await auditRows(id)).toHaveLength(2);
  });

  test("record writes a fact", async () => {
    await transaction(db, (tx) =>
      record(tx, ctx(), {
        action: "thing_happened",
        entityType: "webhook",
        entityId: "w-1",
        changes: { n: 1 },
      }),
    );
    expect((await auditRows("w-1"))[0]).toMatchObject({ action: "thing_happened", changes: { n: 1 } });
  });

  test("the audit log and wheel configs cannot be changed", async () => {
    await expect(db.query("UPDATE audit_log SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE wheel_configs SET version = 9")).rejects.toThrow(/append-only/);
  });

  test("a table outside the allowlist, or a bad column name, throws", async () => {
    await expect(transaction(db, (tx) => create(tx, ctx(), "audit_log", { actor: "x" }))).rejects.toThrow(
      /not audited/,
    );
    await expect(
      transaction(db, (tx) => update(tx, ctx(), "outbox; DROP TABLE x", "1", () => ({}))),
    ).rejects.toThrow(/not audited/);
    await expect(
      transaction(db, (tx) => create(tx, ctx(), "players", { "external_id) VALUES ('x'); --": "x" })),
    ).rejects.toThrow(/bad column/);
  });

  test("tenant secrets are written as ***", async () => {
    const rows = (
      await db.query(
        "SELECT changes FROM audit_log WHERE entity_type = 'tenants' AND entity_id = 'alpha-casino'",
      )
    ).rows;
    const changes = rows[0].changes as { field: string; to: string }[];
    for (const f of ["webhook_secret", "token_secret", "wheel_secret", "admin_key", "platform_key"]) {
      expect(changes.find((c) => c.field === f)?.to).toBe("***");
    }
    expect(JSON.stringify(rows)).not.toContain("demo-alpha");
    expect(changes.find((c) => c.field === "name")?.to).toBe("Alpha Casino");
  });

  test("a failed transaction leaves neither the row nor the audit row", async () => {
    await expect(
      transaction(db, async (tx) => {
        await create(tx, ctx(), "players", { tenant_id: "alpha-casino", external_id: "p-rolled-back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.query("SELECT 1 FROM players WHERE external_id = 'p-rolled-back'")).rowCount).toBe(0);
    expect(
      (await db.query("SELECT 1 FROM audit_log WHERE changes::text LIKE '%p-rolled-back%'")).rowCount,
    ).toBe(0);
  });

  test("seedDemo twice gives two tenants and no extra audit rows", async () => {
    const count = async (sql: string) => (await db.query(sql)).rows[0].n as number;
    const before = await count("SELECT count(*)::int AS n FROM audit_log");
    await seedDemo(db, clock, "http://127.0.0.1:1");
    expect(await count("SELECT count(*)::int AS n FROM tenants")).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM wheel_configs")).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM grant_policies")).toBe(2);
    expect(
      await count("SELECT count(*)::int AS n FROM store_items WHERE code IN ('bonus-5-eur', 'bonus-1-eur')"),
    ).toBe(4);
    expect(await count("SELECT count(*)::int AS n FROM audit_log")).toBe(before);
  });
});
