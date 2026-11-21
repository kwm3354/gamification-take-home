import { describe, expect, it } from "vitest";
import { consequence, fakeCasinoSecretsBody, fakeCasinoSecretsUrl, secondsOf } from "./keys.ts";

describe("tenant keys, small rules of the screen", () => {
  it("the three choices send 0, 3600 and 86400 seconds", () => {
    expect([secondsOf("now"), secondsOf("1h"), secondsOf("24h")]).toEqual([0, 3600, 86400]);
  });

  it("the confirm sentence says what the casino will notice", () => {
    expect(consequence("event_signing", "now")).toBe("Events signed with the old key will be rejected from now on.");
    expect(consequence("player_token", "1h")).toBe("Player tokens signed with the old key will be rejected after 1 hour.");
  });

  it("the demo casino call goes to the right address with the right field", () => {
    expect(fakeCasinoSecretsUrl("http://localhost:30081/", "alpha-casino")).toBe(
      "http://localhost:30081/control/tenants/alpha-casino/secrets",
    );
    expect(fakeCasinoSecretsBody("event_signing", "evs_x")).toEqual({ webhookSecret: "evs_x" });
    expect(fakeCasinoSecretsBody("player_token", "pts_x")).toEqual({ tokenSecret: "pts_x" });
  });
});
