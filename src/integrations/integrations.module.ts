import { Global, Module } from "@nestjs/common";
import { PLATFORMS } from "../domain/casino-platform.ts";
import { PlatformRegistry } from "./platforms.ts";

/** Adapters, one per casino platform. Inject the registry with `@Inject(PLATFORMS)`. */
@Global()
@Module({
  providers: [{ provide: PLATFORMS, useValue: new PlatformRegistry() }],
  exports: [PLATFORMS],
})
export class IntegrationsModule {}
