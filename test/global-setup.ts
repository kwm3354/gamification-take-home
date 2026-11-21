import { PostgreSqlContainer } from "@testcontainers/postgresql";

/** One throwaway PostgreSQL for the whole run. Every test file makes its own database in it. */
export default async function setup() {
  if (process.env.TEST_PG_URL) return;
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
  };
}
