import { Global, Module } from "@nestjs/common";
import { systemClock } from "./clock.ts";

/** Injection token for time: `@Inject(CLOCK) private readonly clock: Clock`. Tests replace it with a FakeClock. */
export const CLOCK = Symbol("CLOCK");

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
