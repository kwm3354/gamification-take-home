import { Module } from "@nestjs/common";
import { TenantsModule } from "../tenants/tenants.module.ts";
import { StoreController } from "./store.controller.ts";
import { StoreService } from "./store.service.ts";

/** The bonus store and redemptions. */
@Module({
  imports: [TenantsModule],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
