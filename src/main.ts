import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { CONFIG, type Config } from "./config.ts";
import { startTracing, tracingOptionsFromEnv } from "./tracing/tracing.ts";
import { defaultWebDir, mountWeb } from "./web.ts";

// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Pending spans are flushed when the app shuts down.
startTracing({ ...tracingOptionsFromEnv(), stopOnAppClose: true });

// rawBody: webhook signatures are computed over the exact bytes received (`req.rawBody`).
const app = await NestFactory.create(AppModule, { rawBody: true });
// The playground page is served from the fake casino's origin and calls this API from the browser.
// The demo allows any origin; a real deployment would list the operators' origins.
app.enableCors();
const config = app.get<Config>(CONFIG);
mountWeb(app, {
  dir: defaultWebDir(),
  fakeCasinoUrl: config.publicFakeCasinoUrl,
  demoAdmins: config.seedDemo,
});
app.enableShutdownHooks();
await app.listen(app.get<Config>(CONFIG).port, "0.0.0.0");
