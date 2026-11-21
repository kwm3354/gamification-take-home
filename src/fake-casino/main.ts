import { startFakeCasino } from "./server.ts";

const port = Number(process.env.PORT ?? 4000);
const appUrl = process.env.APP_URL ?? "http://app:3000";

const casino = await startFakeCasino({ port, appUrl, autoDeliverMs: 1000 });
console.log(`fake casino listening on ${casino.url}, app at ${appUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    casino.close().finally(() => process.exit(0));
  });
}
