import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { CurrentPlayer, type PlayerAuth, PlayerAuthGuard } from "./player-auth.guard.ts";

@Controller("me")
@UseGuards(PlayerAuthGuard)
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async me(@CurrentPlayer() auth: PlayerAuth) {
    const result = await this.db.query(
      "SELECT id, status, coins FROM spins WHERE tenant_id = $1 AND player_id = $2 ORDER BY created_at DESC, id",
      [auth.tenant.id, auth.player.id],
    );
    return {
      playerId: auth.player.id,
      tenantId: auth.tenant.id,
      spins: result.rows.map((r) => ({ id: r.id, status: r.status, coins: r.coins })),
    };
  }
}
