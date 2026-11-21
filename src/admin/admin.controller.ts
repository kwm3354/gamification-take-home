import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { runAlerts } from "../alerts/alerts.ts";
import { loadOpsPolicy } from "../alerts/ops-policy.ts";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { OUTBOX, type Outbox } from "../outbox/outbox.ts";
import { toView } from "../store/redemption.ts";
import { StoreService } from "../store/store.service.ts";
import { AdminGuard, CurrentAdmin, allow } from "./admin-auth.ts";
import { auditTrail, recentAudit } from "./audit-trail.ts";
import { checked } from "./backoffice.controller.ts";
import { parseLimit } from "./paging.ts";
import type { AdminUser } from "./permissions.ts";
import { resolveRedemption } from "./resolve.ts";
import { stuckRedemptions } from "./stuck.ts";

/** Operations: audit trail, stuck redemptions, manual resolution, alerts. Thin; the logic is in the plain files. */
@Controller("admin/:tenantId")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    private readonly store: StoreService,
    @Inject(LOG) private readonly log: Log,
  ) {}

  @Get("audit")
  audit(@Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    if (typeof query.entityId === "string" && query.entityId) {
      return auditTrail(this.db, tenantId, query.entityId);
    }
    if (query.recent === "1") {
      return checked(() => recentAudit(this.db, tenantId, query, parseLimit(query.limit)));
    }
    throw new BadRequestException("entityId or recent=1 is required");
  }

  @Get("redemptions/stuck")
  async stuck(@Param("tenantId") tenantId: string) {
    const policy = await loadOpsPolicy(this.db, tenantId);
    if (!policy) return { limitSec: null, items: [] };
    const limitSec = policy.params.pendingAgeLimitSec;
    return { limitSec, items: await stuckRedemptions(this.db, this.clock, tenantId, limitSec) };
  }

  @Post("redemptions/:id/resolve")
  @HttpCode(200)
  async resolve(
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentAdmin() admin: AdminUser,
  ) {
    allow(admin, "resolve", tenantId);
    const input = parseResolveBody(body);
    const actor = `admin/${admin.id}`;
    const settle = this.config.inlineJobs ? (rid: string, who: string) => this.settle(rid, who) : undefined;
    const result = await resolveRedemption(
      { db: this.db, clock: this.clock, outbox: this.outbox, log: this.log },
      tenantId,
      id,
      input,
      actor,
      settle,
    );
    if (result.kind === "not_found") throw new NotFoundException();
    if (result.kind === "conflict") {
      throw new ConflictException({
        message: "only a submitting redemption can be resolved",
        view: toView(result.row),
      });
    }
    this.log.event("warn", "admin.manual_resolution", {
      tenantId,
      redemptionId: id,
      outcome: input.outcome,
      admin: actor,
    });
    return toView(result.row);
  }

  @Get("alerts")
  alerts(@Param("tenantId") tenantId: string) {
    return runAlerts(this.db, this.clock, tenantId);
  }

  /** The ledger step now. If it fails the queued job does it later. */
  private async settle(id: string, actor: string): Promise<void> {
    try {
      await this.store.advance(id, 0, actor);
    } catch (e) {
      // The queued job settles it later.
      this.log.event("error", "unhandled", {
        where: "admin_settle",
        redemptionId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function parseResolveBody(body: unknown): { outcome: "issued" | "refused"; note: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.outcome !== "issued" && b.outcome !== "refused") {
    throw new BadRequestException('outcome must be "issued" or "refused"');
  }
  if (typeof b.note !== "string" || b.note.trim().length < 5 || b.note.length > 500) {
    throw new BadRequestException("note is required, 5 to 500 characters");
  }
  return { outcome: b.outcome, note: b.note };
}
