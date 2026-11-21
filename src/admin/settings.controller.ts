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
  Res,
  UseGuards,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { AdminGuard, CurrentAdmin, allow } from "./admin-auth.ts";
import { checked } from "./backoffice.controller.ts";
import { isUuid, oneOf } from "./paging.ts";
import type { AdminUser } from "./permissions.ts";
import { decideChange, proposeWheelChange, validateSegments, waitingChanges } from "./settings-change.ts";

type Reply = { status(code: number): unknown };

/** The casino's own admin proposes a new wheel. A policy decides at once, or the change waits. */
@Controller("admin/:tenantId/settings")
@UseGuards(AdminGuard)
export class WheelSettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post("wheel")
  async propose(
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @CurrentAdmin() admin: AdminUser,
    @Res({ passthrough: true }) res: Reply,
  ) {
    allow(admin, "propose_wheel", tenantId);
    const segments = await checked(async () =>
      validateSegments((body as { segments?: unknown } | null)?.segments),
    );
    const result = await proposeWheelChange({ db: this.db, clock: this.clock }, admin.id, tenantId, segments);
    if (result.kind === "no_policy") throw new ConflictException("the tenant has no ops policy");
    if (result.kind === "applied") {
      res.status(201);
      return { change: result.change, wheelVersion: result.wheelVersion };
    }
    res.status(202);
    return { change: result.change };
  }
}

/** What only the platform admin does: see waiting changes, approve or reject one. */
@Controller("platform/settings-changes")
@UseGuards(AdminGuard)
export class PlatformSettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  async waiting(@CurrentAdmin() admin: AdminUser, @Query("status") status?: unknown) {
    allow(admin, "decide_change", null);
    const wanted = await checked(async () =>
      oneOf(status, ["proposed", "applied", "rejected"] as const, "status"),
    );
    return waitingChanges(this.db, wanted ?? "proposed");
  }

  @Post(":id/approve")
  @HttpCode(200)
  approve(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminUser) {
    return this.decide(id, "approve", body, admin);
  }

  @Post(":id/reject")
  @HttpCode(200)
  reject(@Param("id") id: string, @Body() body: unknown, @CurrentAdmin() admin: AdminUser) {
    return this.decide(id, "reject", body, admin);
  }

  private async decide(id: string, decision: "approve" | "reject", body: unknown, admin: AdminUser) {
    allow(admin, "decide_change", null);
    const note = (body as { note?: unknown } | null)?.note;
    if (typeof note !== "string" || note.trim().length < 5 || note.length > 500) {
      throw new BadRequestException("note is required, 5 to 500 characters");
    }
    if (!isUuid(id)) throw new NotFoundException();
    const r = await decideChange({ db: this.db, clock: this.clock }, admin.id, id, decision, note);
    if (r.kind === "not_found") throw new NotFoundException();
    if (r.kind === "conflict") throw new ConflictException("the change is not waiting any more");
    return r.kind === "applied" ? { change: r.change, wheelVersion: r.wheelVersion } : { change: r.change };
  }
}
