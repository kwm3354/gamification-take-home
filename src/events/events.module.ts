import { Module } from "@nestjs/common";
import { EventsController } from "./events.controller.ts";

/** Intake of events from the platforms. */
@Module({ controllers: [EventsController] })
export class EventsModule {}
