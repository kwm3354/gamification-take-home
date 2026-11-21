import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module.ts";
import { AdminAuthController, AdminGuard } from "./admin-auth.ts";
import { AdminController } from "./admin.controller.ts";
import { BackofficeController, PlatformController } from "./backoffice.controller.ts";
import { TenantKeysController } from "./keys.controller.ts";
import { PlatformSettingsController, WheelSettingsController } from "./settings.controller.ts";

/** Operations side: audit trail, stuck redemptions, manual resolution, alerts. */
@Module({
  imports: [StoreModule],
  controllers: [
    AdminAuthController,
    AdminController,
    BackofficeController,
    PlatformController,
    WheelSettingsController,
    PlatformSettingsController,
    TenantKeysController,
  ],
  providers: [AdminGuard],
})
export class AdminModule {}
