import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { currentRequestId } from "../logging/log.ts";
import { CurrentPlayer, type PlayerAuth, PlayerAuthGuard } from "../tenants/player-auth.guard.ts";
import { StoreService } from "./store.service.ts";

const MAX_KEY_LENGTH = 200;

@Controller("store")
@UseGuards(PlayerAuthGuard)
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get("items")
  items(@CurrentPlayer() auth: PlayerAuth) {
    return this.store.items(auth.tenant.id);
  }

  @Post("redemptions")
  async redeem(
    @CurrentPlayer() auth: PlayerAuth,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    if (!key || key.length > MAX_KEY_LENGTH) throw new BadRequestException("Idempotency-Key is required");
    const itemId = (body as { itemId?: unknown } | null)?.itemId;
    if (typeof itemId !== "string" || itemId === "") throw new BadRequestException("itemId is required");
    const result = await this.store.redeem({
      tenantId: auth.tenant.id,
      playerId: auth.player.id,
      externalPlayerId: auth.player.externalId,
      idempotencyKey: key,
      itemId,
      requestId: currentRequestId(),
    });
    if (result === "unknown_item") throw new NotFoundException();
    res.status(result.created ? 201 : 200);
    return result.view;
  }

  @Get("redemptions/:id")
  @HttpCode(200)
  async one(@CurrentPlayer() auth: PlayerAuth, @Param("id") id: string) {
    const view = await this.store.get(auth.tenant.id, auth.player.id, id);
    if (!view) throw new NotFoundException();
    return view;
  }
}
