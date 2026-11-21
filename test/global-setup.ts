import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { startTigerBeetle } from "./tigerbeetle.ts";

/**
 * One throwaway PostgreSQL and one throwaway TigerBeetle for the whole run.
 * Every test file makes its own database in PostgreSQL. All files share the TigerBeetle, as they do
 * in CI, so tests use fresh ids. A server per test file would need about 1 GB of disk each.
 */
export default async function setup() {
  // With TB_ADDRESS set (CI) a server is already running. With only TB_BIN set, start one here.
  const tb = process.env.TB_ADDRESS ? undefined : await startTigerBeetle();
  if (tb) process.env.TB_ADDRESS = tb.address;
  if (process.env.TEST_PG_URL) return () => tb?.stop();
  // Durability is switched off: the data lives for one test run, and this makes it several times faster.
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ])
    .start();
  process.env.TEST_PG_URL = container.getConnectionUri();
  return async () => {
    await container.stop();
    tb?.stop();
  };
}
