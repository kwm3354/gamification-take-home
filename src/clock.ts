export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock the tests move by hand, so no test ever sleeps. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(start = "2026-01-01T00:00:00Z") {
    this.ms = Date.parse(start);
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(to: Date): void {
    if (to.getTime() > this.ms) this.ms = to.getTime();
  }
}

export const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
