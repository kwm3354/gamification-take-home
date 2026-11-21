import { describe, expect, it } from "vitest";
import { playerStatus } from "./status.ts";

describe("playerStatus", () => {
  it("says 'On its way' for every step before the casino answers", () => {
    for (const s of ["created", "reserved", "submitting"]) {
      expect(playerStatus(s)).toEqual({ text: "On its way", tone: "wait", final: false });
    }
  });

  it("says where the reward is when issued", () => {
    expect(playerStatus("issued")).toEqual({ text: "In your casino account", tone: "good", final: true });
  });

  it("tells the player the coins are back when refused", () => {
    const s = playerStatus("refused");
    expect(s.text).toBe("Not available, your coins are back");
    expect(s.final).toBe(true);
  });

  it("says 'Not enough coins' for insufficient", () => {
    expect(playerStatus("insufficient").text).toBe("Not enough coins");
  });

  it("uses no internal words for any status", () => {
    for (const s of ["created", "reserved", "submitting", "issued", "refused", "insufficient", "weird"]) {
      expect(playerStatus(s).text).not.toMatch(/submitting|settled|webhook|tenant|platform/i);
    }
  });
});
