import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { record } from "../audit/audited.ts";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import { type Db, transaction } from "../db.ts";
import {
  InvalidPayload,
  InvalidSignature,
  PLATFORMS,
  type PlatformEvent,
  type Platforms,
} from "../domain/casino-platform.ts";
import { findTenant } from "../tenants/tenants.ts";
import { ingestEvent } from "./deposit.ts";

interface WebhookRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

@Controller("webhooks")
export class EventsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PLATFORMS) private readonly platforms: Platforms,
  ) {}

  @Post(":tenantId/events")
  @HttpCode(200)
  async events(@Param("tenantId") tenantId: string, @Req() req: WebhookRequest) {
    const tenant = await findTenant(this.db, tenantId);
    if (!tenant) throw new NotFoundException();
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException();

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const now = this.clock.now();
    const requestId = headers["x-request-id"] ?? randomUUID();
    const rejection = { tenantId, requestId, now };

    let events: PlatformEvent[];
    try {
      events = this.platforms.for(tenant.platform).parseEvents(
        {
          tenantId,
          platformUrl: tenant.platformUrl,
          platformKey: tenant.platformKey,
          webhookSecret: tenant.webhookSecret,
        },
        headers,
        rawBody,
        now,
      );
    } catch (e) {
      if (e instanceof InvalidSignature) {
        await transaction(this.db, (tx) =>
          record(
            tx,
            { ...rejection, actor: "unknown" },
            {
              action: "webhook_rejected",
              entityType: "webhook",
              entityId: randomUUID(),
              changes: { reason: "bad signature", bytes: rawBody.length },
            },
          ),
        );
        throw new UnauthorizedException();
      }
      if (e instanceof InvalidPayload) {
        await transaction(this.db, (tx) =>
          record(
            tx,
            { ...rejection, actor: `platform/${tenantId}` },
            {
              action: "webhook_invalid",
              entityType: "webhook",
              entityId: randomUUID(),
              changes: { reason: e.message, bytes: rawBody.length },
            },
          ),
        );
        throw new BadRequestException();
      }
      throw e;
    }

    // The body was valid JSON, since the adapter parsed it. Kept as received for the raw column.
    const raw = JSON.parse(rawBody.toString("utf8"));
    const ctx = { ...rejection, actor: `platform/${tenantId}` };
    const counts = { accepted: 0, duplicates: 0, ignored: 0 };
    for (const event of events) {
      const outcome = await transaction(this.db, (tx) => ingestEvent(tx, ctx, tenantId, event, raw));
      if (outcome === "accepted") counts.accepted++;
      else if (outcome === "duplicate") counts.duplicates++;
      else counts.ignored++;
    }
    return counts;
  }
}
