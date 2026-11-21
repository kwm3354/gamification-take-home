import type {
  CasinoPlatform,
  Platforms,
  RewardOutcome,
  RewardRequest,
  TenantConnection,
} from "../domain/casino-platform.ts";
import { span } from "../tracing/tracing.ts";
import { PlatformA } from "./platform-a.ts";
import { PlatformB } from "./platform-b.ts";

/**
 * Puts a span `platform issue A` / `platform find B` around the two outgoing calls. The span carries
 * the tenant and platform, and the status code or the error class; `callPlatform` adds
 * `traceparent` to the request. Parsing is local work and is not traced.
 */
class TracedPlatform implements CasinoPlatform {
  readonly parseEvents: CasinoPlatform["parseEvents"];
  readonly parseRewardNotice: CasinoPlatform["parseRewardNotice"];

  constructor(
    private readonly inner: CasinoPlatform,
    private readonly letter: "A" | "B",
  ) {
    this.parseEvents = inner.parseEvents.bind(inner);
    this.parseRewardNotice = inner.parseRewardNotice.bind(inner);
  }

  issueReward(conn: TenantConnection, request: RewardRequest): Promise<RewardOutcome> {
    return span(`platform issue ${this.letter}`, { "tenant.id": conn.tenantId }, async (s) => {
      const outcome = await this.inner.issueReward(conn, request);
      s.setAttribute("platform.result", outcome.kind);
      return outcome;
    });
  }

  findReward(conn: TenantConnection, redemptionId: string): Promise<RewardOutcome | "not_found"> {
    return span(`platform find ${this.letter}`, { "tenant.id": conn.tenantId }, async (s) => {
      const outcome = await this.inner.findReward(conn, redemptionId);
      s.setAttribute("platform.result", outcome === "not_found" ? outcome : outcome.kind);
      return outcome;
    });
  }
}

/** Picks the adapter for a tenant's platform. */
export class PlatformRegistry implements Platforms {
  private readonly adapters: Record<"A" | "B", CasinoPlatform> = {
    A: new TracedPlatform(new PlatformA(), "A"),
    B: new TracedPlatform(new PlatformB(), "B"),
  };

  for(platform: "A" | "B"): CasinoPlatform {
    return this.adapters[platform];
  }
}
