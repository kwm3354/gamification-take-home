import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // NestJS finds what to inject from decorator metadata. esbuild, which vitest uses by default,
  // does not emit it, and constructor arguments silently become undefined. SWC does emit it.
  // test/health.test.ts fails if this stops working.
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  esbuild: false,
  test: {
    globalSetup: ["test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
