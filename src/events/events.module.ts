import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module.ts";
import { EventsController } from "./events.controller.ts";
import { RewardsController } from "./rewards.controller.ts";

/** Intake of events and reward messages from the platforms. */
@Module({ imports: [StoreModule], controllers: [EventsController, RewardsController] })
export class EventsModule {}
