import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
  createParamDecorator,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { CONFIG, type Config } from "../config.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { LOG } from "../logging/log.module.ts";
import type { Log } from "../logging/log.ts";
import { verifyAdminToken } from "./admin-token.ts";
import { findUserById, login, publicUser } from "./login.ts";
import { type Action, type AdminUser, can } from "./permissions.ts";

export interface AdminRequest {
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  admin?: AdminUser;
}

const BAD = "invalid credentials";

/**
 * Checks the bearer token, loads the user again (a disabled user stops at once) and, when the
 * path names a tenant, checks that this user may see it. A tenant that is not theirs is a 404,
 * the same as an unknown tenant. The rights for an action are checked with `allow` below.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer\s+(\S+)$/i.exec(value ?? "");
    if (!match) throw new UnauthorizedException();
    const claims = verifyAdminToken(this.config.adminTokenSecret, match[1] as string, this.clock.now());
    if (!claims) throw new UnauthorizedException();
    const user = await findUserById(this.db, claims.sub);
    if (!user || user.disabled) throw new UnauthorizedException();
    const admin: AdminUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    };
    const tenantId = req.params.tenantId;
    if (tenantId !== undefined) {
      if (!can(admin, "read", tenantId)) throw new NotFoundException();
      if (admin.role === "platform_admin") {
        const known = await this.db.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
        if (known.rowCount === 0) throw new NotFoundException();
      }
    }
    req.admin = admin;
    return true;
  }
}

/** The signed-in user of this request. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminUser =>
    context.switchToHttp().getRequest<AdminRequest>().admin as AdminUser,
);

/** 403 unless the role allows the action. Tenant visibility (404) was already checked by the guard. */
export function allow(admin: AdminUser, action: Action, tenantId: string | null): void {
  if (!can(admin, action, tenantId)) throw new ForbiddenException();
}

@Controller("admin/auth")
export class AdminAuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOG) private readonly log: Log,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const result = await login(
      { db: this.db, clock: this.clock, secret: this.config.adminTokenSecret, log: this.log },
      b.email,
      b.password,
    );
    if (!result.ok) throw new UnauthorizedException(BAD);
    return { token: result.token, expiresAt: result.expiresAt, user: result.user };
  }

  @Get("me")
  @UseGuards(AdminGuard)
  me(@CurrentAdmin() admin: AdminUser) {
    return publicUser(admin);
  }
}
