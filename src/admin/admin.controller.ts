import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { runAlerts } from "../alerts/alerts.ts";
import { loadOpsPolicy } from "../alerts/ops-policy.ts";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { OUTBOX, type Outbox } from "../outbox/outbox.ts";
import { toView } from "../store/redemption.ts";
import { StoreService } from "../store/store.service.ts";
import { AdminGuard, type AdminRequest } from "./admin.guard.ts";
import { auditTrail } from "./audit-trail.ts";
import { resolveRedemption } from "./resolve.ts";
import { stuckRedemptions } from "./stuck.ts";

/** Operations: audit trail, stuck redemptions, manual resolution, alerts. Thin; the logic is in the plain files. */
@Controller("admin/:tenantId")
@UseGuards(AdminGuard)
export class AdminController {
  private readonly log = new Logger("Admin");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    private readonly store: StoreService,
  ) {}

  @Get("audit")
  audit(@Param("tenantId") tenantId: string, @Query("entityId") entityId?: string) {
    if (!entityId) throw new BadRequestException("entityId is required");
    return auditTrail(this.db, tenantId, entityId);
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
    @Req() req: AdminRequest,
  ) {
    const input = parseResolveBody(body);
    const actor = req.admin?.actor ?? "admin";
    const settle = this.config.inlineJobs ? (rid: string, who: string) => this.settle(rid, who) : undefined;
    const result = await resolveRedemption(
      { db: this.db, clock: this.clock, outbox: this.outbox },
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
      this.log.warn(
        `settling ${id} failed, the outbox job will retry: ${e instanceof Error ? e.message : String(e)}`,
      );
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
