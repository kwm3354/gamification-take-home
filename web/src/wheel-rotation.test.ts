import { describe, expect, it } from "vitest";
import { MIN_TURNS, finalRotation, sliceUnderPointer } from "./wheel-rotation.ts";

describe("finalRotation", () => {
  it("stops every segment under the pointer, for several segment counts", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 12]) {
      for (let i = 0; i < n; i++) {
        for (const start of [0, 37.5, 1234.2]) {
          const r = finalRotation(n, i, start);
          expect(sliceUnderPointer(n, r), `n=${n} i=${i} start=${start}`).toBe(i);
        }
      }
    }
  });

  it("only turns forward, at least the minimum number of full turns, and less than one more", () => {
    for (const n of [3, 4, 6]) {
      let current = 0;
      for (let spin = 0; spin < 20; spin++) {
        const i = (spin * 7) % n;
        const next = finalRotation(n, i, current);
        expect(next - current).toBeGreaterThanOrEqual(MIN_TURNS * 360);
        expect(next - current).toBeLessThan((MIN_TURNS + 1) * 360);
        expect(MIN_TURNS).toBeGreaterThanOrEqual(3);
        current = next;
      }
    }
  });

  it("stops in the middle of the slice, not on its edge", () => {
    const n = 4;
    const r = finalRotation(n, 2, 0);
    const within = (((-r % 360) + 360) % 360) % (360 / n);
    expect(within).toBeCloseTo(360 / n / 2, 6);
  });

  it("rejects an index outside the wheel", () => {
    expect(() => finalRotation(4, 4, 0)).toThrow();
    expect(() => finalRotation(4, -1, 0)).toThrow();
    expect(() => finalRotation(0, 0, 0)).toThrow();
  });
});
