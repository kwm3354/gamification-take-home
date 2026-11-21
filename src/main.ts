import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { CONFIG, type Config } from "./config.ts";

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(app.get<Config>(CONFIG).port, "0.0.0.0");
