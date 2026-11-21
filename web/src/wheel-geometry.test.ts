import { describe, expect, it } from "vitest";
import {
  CHAR_WIDTH,
  LABEL_INNER,
  LABEL_OUTER,
  MAX_FONT,
  MIN_FONT,
  sliceGeometry,
} from "./wheel-geometry.ts";

const COUNTS = [2, 8, 12, 24];
const LABELS = ["5", "10 coins", "Free spins bonus", "A prize with a very long label, forty chars!!"];

describe("wheel geometry", () => {
  for (const n of COUNTS) {
    it(`${n} slices cover the circle exactly, in order, with no gap`, () => {
      const slices = Array.from({ length: n }, (_, i) => sliceGeometry(n, i, "10 coins"));
      expect(slices[0]?.from).toBe(0);
      expect(slices[n - 1]?.to).toBeCloseTo(360, 9);
      for (let i = 1; i < n; i++) expect(slices[i]?.from).toBeCloseTo(slices[i - 1]?.to ?? Number.NaN, 9);
      const total = slices.reduce((sum, s) => sum + (s.to - s.from), 0);
      expect(total).toBeCloseTo(360, 9);
      for (const s of slices) expect(s.mid).toBeCloseTo((s.from + s.to) / 2, 9);
    });

    it(`${n} slices: every label stays inside its slice, between the hub and the rim`, () => {
      const half = Math.sin((Math.PI / n) );
      for (const label of LABELS) {
        for (let i = 0; i < n; i++) {
          const g = sliceGeometry(n, i, label);
          const innerEnd = LABEL_OUTER - g.length;
          expect(innerEnd).toBeGreaterThanOrEqual(LABEL_INNER - 1e-9);
          // Half of the slice's width at the label's inner end must hold half of the font height.
          expect(innerEnd * half).toBeGreaterThanOrEqual(g.fontSize / 2 - 1e-9);
          expect(g.fontSize).toBeGreaterThanOrEqual(MIN_FONT);
          expect(g.fontSize).toBeLessThanOrEqual(MAX_FONT);
          expect(g.length).toBeCloseTo(g.text.length * CHAR_WIDTH * g.fontSize, 9);
        }
      }
    });
  }

  it("keeps short labels whole and cuts only what cannot fit, with dots", () => {
    expect(sliceGeometry(8, 0, "10 coins").text).toBe("10 coins");
    const long = "A prize with a very long label, forty chars!!";
    const cut = sliceGeometry(24, 0, long);
    expect(cut.text.endsWith("...")).toBe(true);
    expect(cut.text.length).toBeLessThan(long.length);
    expect(long.startsWith(cut.text.slice(0, -3))).toBe(true);
  });

  it("draws labels smaller when there are more slices", () => {
    const sizes = COUNTS.map((n) => sliceGeometry(n, 0, "100 coins").fontSize);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1] ?? 0);
  });

  it("turns labels on the left half so that they stay readable", () => {
    expect(sliceGeometry(4, 0, "a").flip).toBe(false);
    expect(sliceGeometry(4, 1, "a").flip).toBe(false);
    expect(sliceGeometry(4, 2, "a").flip).toBe(true);
    expect(sliceGeometry(4, 3, "a").flip).toBe(true);
  });

  it("keeps every label readable when the wheel has turned: flips by where the slice rests, not where it started", () => {
    for (const n of [4, 8, 12]) {
      for (const rotation of [0, 37.5, 90, 181, 400, 1000.25, -75]) {
        for (let i = 0; i < n; i++) {
          const g = sliceGeometry(n, i, "a", rotation);
          const rest = (((g.mid + rotation) % 360) + 360) % 360;
          // A label on the left half of the screen must be turned; on the right half it must not.
          if (rest > 180.001 && rest < 359.999) expect(g.flip).toBe(true);
          if (rest < 179.999 && rest > 0.001) expect(g.flip).toBe(false);
        }
      }
    }
  });

  it("refuses a wheel of fewer than 2 segments or an odd count", () => {
    expect(() => sliceGeometry(1, 0, "a")).toThrow();
    expect(() => sliceGeometry(2.5, 0, "a")).toThrow();
  });
});
