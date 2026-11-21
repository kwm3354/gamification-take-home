import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module.ts";
import { AdminAuthController, AdminGuard } from "./admin-auth.ts";
import { AdminController } from "./admin.controller.ts";

/** Operations side: audit trail, stuck redemptions, manual resolution, alerts. */
@Module({
  imports: [StoreModule],
  controllers: [AdminAuthController, AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}
