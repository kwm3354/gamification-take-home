import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validFaults } from "../src/fake-casino/faults.ts";
import { type FakeCasino, startFakeCasino } from "../src/fake-casino/server.ts";
import { demoAdmins, demoTenants } from "../src/tenants/demo-tenants.ts";

const page = readFileSync(new URL("../src/fake-casino/public/index.html", import.meta.url), "utf8");
let fake: FakeCasino;

beforeAll(async () => {
  fake = await startFakeCasino({
    port: 0,
    appUrl: "http://127.0.0.1:1",
    publicAppUrl: "http://localhost:30080",
  });
});
afterAll(async () => {
  await fake.close();
});

describe("the control page is served", () => {
  it("GET / is html with the three sections", async () => {
    const res = await fetch(`${fake.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<title>Fake casino: control panel</title>");
    for (const heading of ["1. Make the casino misbehave", "2. What the casino really issued", "3. Check"]) {
      expect(text).toContain(heading);
    }
  });

  it("GET /control/config gives the tenants, the app url and no secrets", async () => {
    const body = (await (await fetch(`${fake.url}/control/config`)).json()) as {
      appUrl: string;
      tenants: { id: string; name: string; platform: string }[];
    };
    expect(body.appUrl).toBe("http://localhost:30080");
    expect(body.tenants.map((t) => [t.id, t.platform])).toEqual(demoTenants.map((t) => [t.id, t.platform]));
    expect(JSON.stringify(body)).not.toMatch(/admin_?key/i);
  });
});

describe("the scenarios on the page", () => {
  const faultsBlock = page.slice(
    page.indexOf("/* faults:start */") + "/* faults:start */".length,
    page.indexOf("/* faults:end */"),
  );
  type Scenario = { id: string; kind: string; fault: string; platforms: string[]; title: string };
  type Body = { point: string; fault: string; times: number; tenantId: string; delayMs?: number };
  const { SCENARIOS, armRequest } = new Function(`${faultsBlock}; return { SCENARIOS, armRequest };`)() as {
    SCENARIOS: Scenario[];
    armRequest: (s: Scenario, t: { id: string; platform: string }, times: number) => Body;
  };
  const armed = async () => (await (await fetch(`${fake.url}/control/faults`)).json()) as Body[];

  it("each scenario, switched on for each casino it offers, is accepted by the control API", async () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    for (const s of SCENARIOS) {
      for (const t of demoTenants.filter((x) => s.platforms.includes(x.platform))) {
        const body = armRequest(s, t, 3);
        const res = await fetch(`${fake.url}/control/faults`, { method: "POST", body: JSON.stringify(body) });
        expect(res.status, `${s.id} on ${t.id}: ${JSON.stringify(body)}`).toBe(200);
      }
    }
    // One rule per scenario and casino, each for the tenant the page chose, with the count the page sent.
    const rules = await armed();
    const expected = SCENARIOS.reduce(
      (n, s) => n + demoTenants.filter((x) => s.platforms.includes(x.platform)).length,
      0,
    );
    expect(rules).toHaveLength(expected);
    for (const r of rules) {
      expect(r.times).toBe(3);
      expect(demoTenants.map((t) => t.id)).toContain(r.tenantId);
    }
    await fetch(`${fake.url}/control/faults/clear`, { method: "POST" });
    expect(await armed()).toEqual([]);
  });

  it("a scenario for platform B only is not offered to platform A", () => {
    for (const s of SCENARIOS.filter((x) => x.kind === "callback")) expect(s.platforms).toEqual(["B"]);
  });

  it("every grant fault and every callback fault of the API has a scenario", () => {
    const has = (point: string, fault: string) =>
      SCENARIOS.some((s) =>
        demoTenants.some((t) => {
          if (!s.platforms.includes(t.platform)) return false;
          const b = armRequest(s, t, 1);
          return b.point === point && b.fault === fault;
        }),
      );
    for (const point of ["a.grant", "b.grant", "b.callback"] as const) {
      for (const fault of validFaults[point]) expect(has(point, fault), `${point} ${fault}`).toBe(true);
    }
  });

  it("the armed list the page reads maps each rule back to its scenario", async () => {
    const s = SCENARIOS.find((x) => x.id === "lost_answer") as Scenario;
    const t = demoTenants[0] as (typeof demoTenants)[number];
    await fetch(`${fake.url}/control/faults`, {
      method: "POST",
      body: JSON.stringify(armRequest(s, t, 2)),
    });
    const scenarioOf = new Function(`${faultsBlock}; return scenarioOf;`)() as (r: Body) => Scenario;
    const [rule] = await armed();
    expect(scenarioOf(rule as Body).id).toBe("lost_answer");
    expect(rule).toMatchObject({ point: "a.grant", fault: "lost_answer", times: 2, tenantId: t.id });
    await fetch(`${fake.url}/control/faults/clear`, { method: "POST" });
  });
});

describe("what the check reads", () => {
  it("/control/players lists the players the casino has met and the references they asked for", async () => {
    const alpha = demoTenants[0] as (typeof demoTenants)[number];
    const token = await fetch(`${fake.url}/control/token`, {
      method: "POST",
      body: JSON.stringify({ tenantId: alpha.id, playerId: "panel-p1" }),
    });
    expect(((await token.json()) as { token: string }).token).toBeTruthy();
    const grant = await fetch(`${fake.url}/a/bonuses`, {
      method: "POST",
      headers: { authorization: `Bearer ${alpha.platformKey}`, "idempotency-key": "k-panel-1" },
      body: JSON.stringify({
        player_id: "panel-p1",
        amount_minor: 500,
        currency: "EUR",
        reference: "ref-panel-1",
      }),
    });
    expect(grant.status).toBe(201);
    const players = (await (await fetch(`${fake.url}/control/players`)).json()) as {
      tenantId: string;
      playerId: string;
      references: string[];
    }[];
    expect(players).toContainEqual({ tenantId: alpha.id, playerId: "panel-p1", references: ["ref-panel-1"] });
  });

  it("/control/state has the fields the page reads for the table and the check", async () => {
    const state = (await (await fetch(`${fake.url}/control/state`)).json()) as {
      grants: Record<string, unknown>[];
      requests: Record<string, unknown>[];
    };
    const g = state.grants.find((x) => x.reference === "ref-panel-1");
    expect(g).toMatchObject({
      tenantId: "alpha-casino",
      playerId: "panel-p1",
      amountMinor: 500,
      currency: "EUR",
    });
    expect(Object.keys(g as object)).toEqual(expect.arrayContaining(["platformRef", "at", "reference"]));
    const q = state.requests.find((x) => x.reference === "ref-panel-1");
    expect(q).toMatchObject({ point: "a.grant", tenantId: "alpha-casino" });
  });

  it("reset forgets the players", async () => {
    await fetch(`${fake.url}/control/reset`, { method: "POST" });
    expect(await (await fetch(`${fake.url}/control/players`)).json()).toEqual([]);
  });
});

describe("static checks on the page", () => {
  it("makes no external requests and uses no browser dialogs", () => {
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/\b(alert|confirm|prompt)\(/);
    expect(page).not.toMatch(/<script[^>]*\ssrc=/);
    expect(page).not.toMatch(/<link[^>]*href=/);
  });

  it("holds none of the demo secrets", () => {
    for (const t of demoTenants) {
      for (const secret of [t.webhookSecret, t.tokenSecret, t.wheelSecret, t.platformKey]) {
        expect(page).not.toContain(secret);
      }
    }
  });

  it("holds none of the demo admin passwords", () => {
    for (const u of demoAdmins) expect(page).not.toContain(u.password);
  });

  it("every id the script looks up exists in the markup", () => {
    const markup = page.slice(0, page.indexOf("<script>"));
    const script = page.slice(page.indexOf("<script>"));
    const wanted = new Set<string>();
    for (const m of script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1] as string);
    for (const m of script.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1] as string);
    for (const m of script.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1] as string);
    expect(wanted.size).toBeGreaterThan(8);
    for (const id of wanted) expect(markup, `id ${id}`).toContain(`id="${id}"`);
  });

  it("the app enables CORS in main.ts", () => {
    // test/app.ts builds the app itself, so a browser preflight cannot be tested here.
    // It is checked against the running compose stack by hand.
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("app.enableCors()");
  });
});

describe("the verdict rules of the page", () => {
  const block = page.slice(
    page.indexOf("/* verdict:start */") + "/* verdict:start */".length,
    page.indexOf("/* verdict:end */"),
  );
  type Verdict = { ok: boolean; lines: { key: string; ids: string[] }[]; notFinal: number };
  const judge = new Function(`${block}; return judgeVerdict;`)() as (input: unknown) => Verdict;

  const T = "alpha-casino";
  const player = (over: object = {}) => ({
    tenantId: T,
    playerId: "p1",
    creditedCoins: 600,
    balance: { available: 500, reserved: 0 },
    redemptions: [{ id: "r1", status: "issued", costCoins: 100 }],
    ...over,
  });
  const grant = (over: object = {}) => ({ tenantId: T, playerId: "p1", reference: "r1", ...over });
  const failed = (v: Verdict) => v.lines.filter((l) => l.ids.length > 0).map((l) => l.key);

  it("passes a clean case", () => {
    const v = judge({ grants: [grant()], players: [player()] });
    expect(v.ok).toBe(true);
    expect(failed(v)).toEqual([]);
  });

  it("ignores grants of redemptions that are not in the session", () => {
    expect(judge({ grants: [grant(), grant({ reference: "other" })], players: [player()] }).ok).toBe(true);
  });

  it("flags a double grant", () => {
    expect(failed(judge({ grants: [grant(), grant()], players: [player()] }))).toEqual(["twice"]);
  });

  it("flags issued without a grant", () => {
    expect(failed(judge({ grants: [], players: [player()] }))).toEqual(["issuedNoGrant"]);
  });

  it("flags a grant for a refused redemption", () => {
    const p = player({
      balance: { available: 600, reserved: 0 },
      redemptions: [{ id: "r1", status: "refused", costCoins: 100 }],
    });
    expect(failed(judge({ grants: [grant()], players: [p] }))).toEqual(["refusedButGranted"]);
  });

  it("flags a grant sent to another player", () => {
    expect(failed(judge({ grants: [grant({ playerId: "p2" })], players: [player()] }))).toEqual([
      "wrongPlayer",
    ]);
  });

  it("flags a negative balance", () => {
    const p = player({ balance: { available: -1, reserved: 0 } });
    expect(failed(judge({ grants: [grant()], players: [p] }))).toContain("negative");
  });

  it("flags coins that do not add up, only for settled players", () => {
    const off = player({ balance: { available: 400, reserved: 0 } });
    expect(failed(judge({ grants: [grant()], players: [off] }))).toEqual(["mismatch"]);
    const holding = player({
      balance: { available: 400, reserved: 100 },
      redemptions: [{ id: "r1", status: "submitting", costCoins: 100 }],
    });
    const v = judge({ grants: [], players: [holding] });
    expect(v.ok).toBe(true);
    expect(v.notFinal).toBe(1);
  });
});
