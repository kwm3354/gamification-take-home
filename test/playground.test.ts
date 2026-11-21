import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("the playground page is served", () => {
  it("GET / is html with the section headings", async () => {
    const res = await fetch(`${fake.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    for (const heading of [
      "Context",
      "Player",
      "Steps",
      "Faults",
      "Run many players",
      "Verdict",
      "Back office",
      "Request log",
    ]) {
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
    expect(wanted.size).toBeGreaterThan(30);
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
