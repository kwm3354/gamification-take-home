import type { CasinoPlatform, Platforms } from "../domain/casino-platform.ts";
import { PlatformA } from "./platform-a.ts";
import { PlatformB } from "./platform-b.ts";

/** Picks the adapter for a tenant's platform. */
export class PlatformRegistry implements Platforms {
  private readonly adapters: Record<"A" | "B", CasinoPlatform> = { A: new PlatformA(), B: new PlatformB() };

  for(platform: "A" | "B"): CasinoPlatform {
    return this.adapters[platform];
  }
}
