/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The service serves the build at /app/. Routes use the URL hash, so one index.html is enough.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
