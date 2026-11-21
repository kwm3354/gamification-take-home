import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { startApp } from "./app.ts";

// The service serves the built web app at /app/. These tests use a small fake build folder,
// because the real build is made by `npm run web:build`, not by the backend tests.
// Skipped when no TigerBeetle is available (neither TB_ADDRESS nor TB_BIN is set).
const dir = mkdtempSync(join(tmpdir(), "web-build-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>fake build</title>");
writeFileSync(join(dir, "assets", "x.js"), "export const x = 1;");

const without = await startApp();
const withBuild = await startApp({ webDir: dir });
afterAll(async () => {
  await without?.close();
  await withBuild?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!without)("the service starts and /health works when there is no web build", async () => {
  const res = await fetch(`${without?.url}/health`);
  expect(res.status).toBe(200);
  const app = await fetch(`${without?.url}/app/`);
  expect(app.status).toBe(404);
});

test.skipIf(!without)("GET /app-config.json gives the address of the simulated casino", async () => {
  const res = await fetch(`${without?.url}/app-config.json`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ fakeCasinoUrl: "http://localhost:30081" });
});

test.skipIf(!withBuild)("/app/ and /app/anything return index.html", async () => {
  for (const path of ["/app/", "/app/anything", "/app/deep/route"]) {
    const res = await fetch(`${withBuild?.url}${path}`);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("fake build");
  }
});

test.skipIf(!withBuild)("/app/assets/x.js returns the file, and a missing file is a 404", async () => {
  const res = await fetch(`${withBuild?.url}/app/assets/x.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(await res.text()).toBe("export const x = 1;");
  expect((await fetch(`${withBuild?.url}/app/assets/missing.js`)).status).toBe(404);
});

test.skipIf(!withBuild)("a path that climbs out of the build folder does not leak files", async () => {
  const res = await fetch(`${withBuild?.url}/app/..%2f..%2fetc%2fpasswd`);
  expect(await res.text()).not.toContain("root:");
});

test.skipIf(!withBuild)("API routes are not shadowed by the static handler", async () => {
  expect((await fetch(`${withBuild?.url}/health`)).status).toBe(200);
  expect((await fetch(`${withBuild?.url}/me`)).status).toBe(401);
  expect((await fetch(`${withBuild?.url}/wheel`)).status).toBe(401);
});
