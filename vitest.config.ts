import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
