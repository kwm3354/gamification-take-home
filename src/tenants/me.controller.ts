import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { DB } from "../db.module.ts";
import type { Db } from "../db.ts";
import { COIN_LEDGER, type CoinLedger, LedgerUnavailable } from "../domain/coin-ledger.ts";
import { CurrentPlayer, type PlayerAuth, PlayerAuthGuard } from "./player-auth.guard.ts";

@Controller("me")
@UseGuards(PlayerAuthGuard)
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(COIN_LEDGER) private readonly coins: CoinLedger,
  ) {}

  @Get()
  async me(@CurrentPlayer() auth: PlayerAuth) {
    const result = await this.db.query(
      "SELECT id, status, coins FROM spins WHERE tenant_id = $1 AND player_id = $2 ORDER BY created_at DESC, id",
      [auth.tenant.id, auth.player.id],
    );
    // The page must load even when the ledger is away.
    let balance: { available: string; reserved: string } | null = null;
    try {
      const b = await this.coins.balance({ ledgerNo: auth.tenant.ledgerNo, playerId: auth.player.id });
      balance = { available: String(b.available), reserved: String(b.reserved) };
    } catch (e) {
      if (!(e instanceof LedgerUnavailable)) throw e;
    }
    return {
      playerId: auth.player.id,
      tenantId: auth.tenant.id,
      balance,
      spins: result.rows.map((r) => ({ id: r.id, status: r.status, coins: r.coins })),
    };
  }
}
