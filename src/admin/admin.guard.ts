import { createHash, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { type Tenant, findTenant } from "../tenants/tenants.ts";

export interface AdminRequest {
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  admin?: { tenant: Tenant; actor: string };
}

const NAME = /^[a-z0-9._-]{1,40}$/;
const digest = (s: string) => createHash("sha256").update(s).digest();
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `X-Admin-Key` must equal the admin key of the tenant in the path. An unknown tenant and a wrong
 * key give the same 401. The actor is `admin/<X-Admin-Name>` (default "admin").
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const tenant = await findTenant(this.db, String(req.params.tenantId ?? ""));
    const given = first(req.headers["x-admin-key"]) ?? "";
    // Compare digests of equal length; an unknown tenant is compared too, so the work is the same.
    const same = timingSafeEqual(digest(given), digest(tenant?.adminKey ?? ""));
    if (!tenant || !same || given === "") throw new UnauthorizedException();
    const name = first(req.headers["x-admin-name"]) ?? "admin";
    if (!NAME.test(name)) throw new BadRequestException("X-Admin-Name must match [a-z0-9._-]{1,40}");
    req.admin = { tenant, actor: `admin/${name}` };
    return true;
  }
}
