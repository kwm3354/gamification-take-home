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
  NotSupported,
  PLATFORMS,
  type Platforms,
  type RewardNotice,
} from "../domain/casino-platform.ts";
import { StoreService } from "../store/store.service.ts";
import { findTenant } from "../tenants/tenants.ts";

interface WebhookRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** The platform's message about a reward (platform B). */
@Controller("webhooks")
export class RewardsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PLATFORMS) private readonly platforms: Platforms,
    private readonly store: StoreService,
  ) {}

  @Post(":tenantId/rewards")
  @HttpCode(200)
  async rewards(@Param("tenantId") tenantId: string, @Req() req: WebhookRequest) {
    const tenant = await findTenant(this.db, tenantId);
    if (!tenant) throw new NotFoundException();
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException();

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const now = this.clock.now();
    const rejection = { tenantId, requestId: headers["x-request-id"] ?? randomUUID(), now };
    const reject = (actor: string, action: string, reason: string) =>
      transaction(this.db, (tx) =>
        record(
          tx,
          { ...rejection, actor },
          {
            action,
            entityType: "webhook",
            entityId: randomUUID(),
            changes: { reason, bytes: rawBody.length },
          },
        ),
      );

    let notice: RewardNotice;
    try {
      notice = this.platforms.for(tenant.platform).parseRewardNotice(
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
        await reject("unknown", "webhook_rejected", "bad signature");
        throw new UnauthorizedException();
      }
      if (e instanceof InvalidPayload) {
        await reject(`platform/${tenantId}`, "webhook_invalid", e.message);
        throw new BadRequestException();
      }
      if (e instanceof NotSupported) throw new BadRequestException();
      throw e;
    }

    const view = await this.store.onRewardNotice(tenantId, notice);
    if (!view) throw new NotFoundException(); // not a redemption of this tenant
    return { redemptionId: view.id, status: view.status };
  }
}
