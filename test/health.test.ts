import { afterAll, expect, test } from "vitest";
import { startApp } from "./app.ts";

// Boots the whole Nest app in this process and calls it over real HTTP.
// It also guards the test toolchain: HealthController gets HealthService by class, with no
// @Inject, so if decorator metadata is not emitted under vitest the first test fails.
// Skipped when no TigerBeetle is available (neither TB_ADDRESS nor TB_BIN is set).
const running = await startApp();
afterAll(() => running?.close());

test.skipIf(!running)("GET /health is 200 when PostgreSQL and the ledger both answer", async () => {
  const response = await fetch(`${running?.url}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, postgres: "ok", ledger: "ok" });
});

test.skipIf(!running)("GET /health is 503 when the ledger does not answer", async () => {
  // Nothing listens on port 1. The health check gives up after its own timeout (2 s).
  const broken = await startApp({ tbAddress: "127.0.0.1:1" });
  try {
    const response = await fetch(`${broken?.url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, postgres: "ok" });
  } finally {
    await broken?.close();
  }
});
