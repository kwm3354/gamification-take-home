import { randomUUID } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import { type Db, transaction } from "../db.ts";
import { currentRequestId } from "../logging/log.ts";
import { verifyPlayerToken } from "./player-token.ts";
import { type Player, findOrCreatePlayer } from "./players.ts";
import { type Tenant, findTenant } from "./tenants.ts";

export interface PlayerAuth {
  tenant: Tenant;
  player: Player;
}

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  playerAuth?: PlayerAuth;
}

/** Tenant and player come from the token only. Any failure is the same 401. */
@Injectable()
export class PlayerAuthGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match?.[1]) throw new UnauthorizedException();
    const verified = await verifyPlayerToken(match[1], this.clock.now(), (id) => findTenant(this.db, id));
    if (!verified) throw new UnauthorizedException();
    const ctx = {
      tenantId: verified.tenant.id,
      actor: "unknown", // the player row is made under player/<our player id>, see below
      requestId: currentRequestId() ?? randomUUID(),
      now: this.clock.now(),
    };
    const player = await transaction(this.db, (tx) =>
      findOrCreatePlayer(tx, ctx, verified.tenant.id, verified.externalId, (id) => `player/${id}`),
    );
    req.playerAuth = { tenant: verified.tenant, player };
    return true;
  }
}

/** The authenticated player of this request: `@CurrentPlayer() auth: PlayerAuth`. */
export const CurrentPlayer = createParamDecorator((_data: unknown, context: ExecutionContext): PlayerAuth => {
  return context.switchToHttp().getRequest<AuthedRequest>().playerAuth as PlayerAuth;
});
