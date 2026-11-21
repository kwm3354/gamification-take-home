import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module.ts";
import { AdminController } from "./admin.controller.ts";
import { AdminGuard } from "./admin.guard.ts";

/** Operations side: audit trail, stuck redemptions, manual resolution, alerts. */
@Module({ imports: [StoreModule], controllers: [AdminController], providers: [AdminGuard] })
export class AdminModule {}
