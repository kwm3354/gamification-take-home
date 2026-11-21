import { describe, expect, it } from "vitest";
import {
  expectedParts,
  expectedPrize,
  limitSentence,
  segmentProblems,
  sharePercent,
  withinLimit,
} from "./expected-prize.ts";

const V1 = [
  { coins: 10, weight: 50 },
  { coins: 50, weight: 30 },
  { coins: 100, weight: 15 },
  { coins: 500, weight: 5 },
];

describe("expected prize", () => {
  it("sums integers: coins * weight and weights", () => {
    expect(expectedParts(V1)).toEqual({ weighted: 6000, totalWeight: 100 });
  });

  it("divides once, for display: wheel version 1 expects 60", () => {
    expect(expectedPrize(V1)).toBe(60);
  });

  it("rounds to 2 places", () => {
    expect(
      expectedPrize([
        { coins: 1, weight: 1 },
        { coins: 2, weight: 2 },
      ]),
    ).toBe(1.67);
  });

  it("has no value without weight", () => {
    expect(expectedPrize([])).toBeNull();
  });

  it("decides the limit on integers, with no rounding error at the edge", () => {
    // 100 * 3 = 300 = weighted: exactly at the limit is within it.
    const edge = [
      { coins: 100, weight: 1 },
      { coins: 100, weight: 2 },
    ];
    expect(withinLimit(edge, 100)).toBe(true);
    // One coin more in the heavier segment tips it over: 302 > 300.
    const over = [
      { coins: 100, weight: 1 },
      { coins: 101, weight: 2 },
    ];
    expect(withinLimit(over, 100)).toBe(false);
  });

  it("says within / above in plain words", () => {
    expect(limitSentence(V1, 100)).toBe("Within the limit: this change will be applied at once.");
    expect(
      limitSentence(
        [
          { coins: 10, weight: 50 },
          { coins: 400, weight: 50 },
        ],
        100,
      ),
    ).toBe("Above the limit of 100: this change will wait for the platform team.");
  });

  it("shows shares in percent with one decimal", () => {
    expect(sharePercent(50, 100)).toBe("50.0");
    expect(sharePercent(1, 3)).toBe("33.3");
    expect(sharePercent(1, 0)).toBe("0.0");
  });
});

describe("segment checks", () => {
  const ok = { label: "10 coins", coins: 10, weight: 5 };

  it("accepts 2 to 24 valid segments", () => {
    expect(segmentProblems([ok, ok])).toEqual([]);
    expect(segmentProblems(Array.from({ length: 24 }, () => ok))).toEqual([]);
  });

  it("refuses 1 and 25 segments", () => {
    expect(segmentProblems([ok])).toHaveLength(1);
    expect(segmentProblems(Array.from({ length: 25 }, () => ok))).toHaveLength(1);
  });

  it("refuses an empty or long label, zero, fractions, empty numbers and numbers above a million", () => {
    expect(segmentProblems([{ ...ok, label: "" }, ok])).toHaveLength(1);
    expect(segmentProblems([{ ...ok, label: "x".repeat(41) }, ok])).toHaveLength(1);
    expect(segmentProblems([{ ...ok, coins: 0 }, ok])).toHaveLength(1);
    expect(segmentProblems([{ ...ok, weight: 1.5 }, ok])).toHaveLength(1);
    expect(segmentProblems([{ ...ok, coins: Number.NaN }, ok])).toHaveLength(1);
    expect(segmentProblems([{ ...ok, weight: 1_000_001 }, ok])).toHaveLength(1);
  });
});
