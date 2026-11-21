import { type FakeCasino, startFakeCasino } from "../src/fake-casino/server.ts";

/**
 * Starts the fake casino in this process on a random port, with no timer: tests deliver the
 * platform B callbacks by hand with `POST {url}/control/b/deliver`.
 * `appUrl` is where the fake sends events and callbacks (our app, or a stub receiver).
 */
export function startFake(appUrl: string): Promise<FakeCasino> {
  return startFakeCasino({ port: 0, appUrl, autoDeliverMs: null });
}
