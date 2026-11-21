import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CLOCK } from "../clock.module.ts";
import type { Clock } from "../clock.ts";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { COIN_LEDGER, type CoinLedger } from "../domain/coin-ledger.ts";
import { type Tenant, findTenant } from "../tenants/tenants.ts";
import { AdminGuard, CurrentAdmin } from "./admin-auth.ts";
import { eventDetail, listEvents } from "./list-events.ts";
import { listOutbox } from "./list-outbox.ts";
import { listPlayers, playerDetail } from "./list-players.ts";
import { listRedemptions, redemptionDetail } from "./list-redemptions.ts";
import { listSpins } from "./list-spins.ts";
import { overview } from "./overview.ts";
import { BadQuery, parseLimit } from "./paging.ts";
import type { AdminUser } from "./permissions.ts";
import { readSettings } from "./settings.ts";

/** A bad filter, cursor or limit is the caller's mistake: 400, not 500. */
export async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof BadQuery) throw new BadRequestException(e.message);
    throw e;
  }
}

/**
 * Read endpoints of the back office. Thin: the queries are in the plain files next to this one.
 * The guard has already checked that the signed-in user may read the tenant in the path.
 */
@Controller("admin/:tenantId")
@UseGuards(AdminGuard)
export class BackofficeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COIN_LEDGER) private readonly coins: CoinLedger,
  ) {}

  private async tenant(id: string): Promise<Tenant> {
    const t = await findTenant(this.db, id);
    if (!t) throw new NotFoundException();
    return t;
  }

  @Get("overview")
  async overview(@Param("tenantId") tenantId: string) {
    const t = await this.tenant(tenantId);
    return overview({ db: this.db, clock: this.clock, coins: this.coins }, t);
  }

  @Get("redemptions")
  redemptions(@Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    return checked(() => listRedemptions(this.db, tenantId, query, parseLimit(query.limit)));
  }

  @Get("redemptions/:id")
  async redemption(@Param("tenantId") tenantId: string, @Param("id") id: string) {
    const found = await redemptionDetail(this.db, tenantId, id);
    if (!found) throw new NotFoundException();
    return found;
  }

  @Get("players")
  players(@Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    return checked(() => listPlayers(this.db, tenantId, query, parseLimit(query.limit)));
  }

  @Get("players/:id")
  async player(@Param("tenantId") tenantId: string, @Param("id") id: string) {
    const found = await playerDetail(this.db, this.coins, await this.tenant(tenantId), id);
    if (!found) throw new NotFoundException();
    return found;
  }

  @Get("events")
  events(@Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    return checked(() => listEvents(this.db, tenantId, query, parseLimit(query.limit)));
  }

  @Get("events/:id")
  async event(@Param("tenantId") tenantId: string, @Param("id") id: string) {
    const found = await eventDetail(this.db, tenantId, id);
    if (!found) throw new NotFoundException();
    return found;
  }

  @Get("spins")
  spins(@Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    return checked(() => listSpins(this.db, tenantId, query, parseLimit(query.limit)));
  }

  @Get("outbox")
  outbox(@Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    return checked(() => listOutbox(this.db, this.clock, tenantId, query, parseLimit(query.limit)));
  }

  @Get("settings")
  settings(@Param("tenantId") tenantId: string) {
    return readSettings(this.db, tenantId);
  }
}

/** `GET /platform/tenants`: the platform admin sees every tenant, anyone else only their own. */
@Controller("platform")
@UseGuards(AdminGuard)
export class PlatformController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("tenants")
  async tenants(@CurrentAdmin() admin: AdminUser) {
    const { rows } =
      admin.role === "platform_admin"
        ? await this.db.query("SELECT id, name, platform FROM tenants ORDER BY id")
        : await this.db.query("SELECT id, name, platform FROM tenants WHERE id = $1", [admin.tenantId]);
    return rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform }));
  }
}
