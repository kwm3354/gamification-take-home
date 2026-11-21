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
import { LOG } from "../logging/log.module.ts";
import { type Log, currentRequestId } from "../logging/log.ts";
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
    @Inject(LOG) private readonly log: Log,
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
    const requestId = currentRequestId() ?? randomUUID();
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
        this.log.event("warn", "webhook.rejected", {
          tenantId,
          reason: "bad signature",
          bytes: rawBody.length,
        });
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
        this.log.event("warn", "webhook.invalid", { tenantId, reason: e.message });
        throw new BadRequestException();
      }
      throw e;
    }

    // The body was valid JSON, since the adapter parsed it. Kept as received for the raw column.
    const raw = JSON.parse(rawBody.toString("utf8"));
    const ctx = { ...rejection, actor: `platform/${tenantId}` };
    const counts = { accepted: 0, duplicates: 0, ignored: 0 };
    for (const event of events) {
      const done = await transaction(this.db, (tx) => ingestEvent(tx, ctx, tenantId, event, raw));
      const externalEventId = event.externalEventId;
      if (done.outcome === "accepted") {
        counts.accepted++;
        this.log.event("info", "event.accepted", {
          tenantId,
          externalEventId,
          kind: event.kind,
          spinsGranted: done.spinsGranted,
        });
      } else if (done.outcome === "duplicate") {
        counts.duplicates++;
        this.log.event("info", "event.duplicate", { tenantId, externalEventId });
      } else {
        counts.ignored++;
        this.log.event("debug", "event.ignored", { tenantId, externalEventId, why: done.why });
      }
    }
    return counts;
  }
}
