import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { CONFIG, type Config } from "./config.ts";

// rawBody: webhook signatures are computed over the exact bytes received (`req.rawBody`).
const app = await NestFactory.create(AppModule, { rawBody: true });
app.enableShutdownHooks();
await app.listen(app.get<Config>(CONFIG).port, "0.0.0.0");
