import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { AdminGuard, CurrentAdmin, allow } from "./admin-auth.ts";
import type { AdminUser } from "./permissions.ts";
import {
  KEY_KINDS,
  type KeyKind,
  MAX_PREVIOUS_SEC,
  listKeys,
  revokePrevious,
  rotateKey,
} from "./tenant-keys.ts";

function kindOf(raw: string): KeyKind {
  const kind = KEY_KINDS.find((k) => k === raw);
  if (!kind) throw new NotFoundException();
  return kind;
}

/** The tenant's secrets: masked list, replace, drop the previous one. The tenant check is the guard's. */
@Controller("admin/:tenantId/keys")
@UseGuards(AdminGuard)
export class TenantKeysController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOG) private readonly log: Log,
  ) {}

  @Get()
  async list(@Param("tenantId") tenantId: string) {
    const keys = await listKeys(this.db, this.clock, tenantId);
    if (!keys) throw new NotFoundException();
    return keys;
  }

  @Post(":kind/rotate")
  async rotate(
    @Param("tenantId") tenantId: string,
    @Param("kind") rawKind: string,
    @Body() body: unknown,
    @CurrentAdmin() admin: AdminUser,
  ) {
    allow(admin, "manage_keys", tenantId);
    const kind = kindOf(rawKind);
    const sec = (body as { previousValidForSec?: unknown } | null)?.previousValidForSec;
    if (typeof sec !== "number" || !Number.isInteger(sec) || sec < 0 || sec > MAX_PREVIOUS_SEC) {
      throw new BadRequestException(`previousValidForSec must be an integer from 0 to ${MAX_PREVIOUS_SEC}`);
    }
    const done = await rotateKey(
      { db: this.db, clock: this.clock, log: this.log },
      admin.id,
      tenantId,
      kind,
      sec,
    );
    if (!done) throw new NotFoundException();
    return { kind: done.kind, secret: done.secret, hint: done.hint, previous: done.previous };
  }

  @Post(":kind/revoke-previous")
  @HttpCode(200)
  async revoke(
    @Param("tenantId") tenantId: string,
    @Param("kind") rawKind: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    allow(admin, "manage_keys", tenantId);
    const done = await revokePrevious(
      { db: this.db, clock: this.clock, log: this.log },
      admin.id,
      tenantId,
      kindOf(rawKind),
    );
    if (!done) throw new NotFoundException();
    return done;
  }
}
