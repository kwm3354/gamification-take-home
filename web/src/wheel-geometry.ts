/** Where the slices of the wheel and their labels go, for any number of segments (2 to 24). Degrees, clockwise, 0 at the top. */

export const CENTER = 200;
export const SLICE_RADIUS = 160;
/** Labels end here, inside the rim and clear of the pointer (its tip reaches radius 140), and run toward the hub. */
export const LABEL_OUTER = 134;
/** Labels never come closer to the hub than this (the hub has radius 34). */
export const LABEL_INNER = 46;
export const MAX_FONT = 16;
export const MIN_FONT = 7;
/** Average width of one character of the label font, as a share of the font size. A bold display face is wide. */
export const CHAR_WIDTH = 0.62;

export interface SliceGeometry {
  from: number;
  to: number;
  mid: number;
  /** The label as drawn: the full text, or a shortened one ending in "..." when even the smallest size does not fit. */
  text: string;
  fontSize: number;
  /** The label rests on the left half of the screen, so it is turned the other way to stay readable. */
  flip: boolean;
  /** How far the label reaches from the rim toward the hub. */
  length: number;
}

/** Left half of the screen: the angle is past the bottom and before the top. The top and the bottom are not flipped. */
function isLeftHalf(angle: number): boolean {
  const a = ((angle % 360) + 360) % 360;
  return a > 180 + 1e-6 && a < 360 - 1e-6;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Does a label of `chars` characters at `fontSize` fit inside a slice of `sliceAngle` degrees? */
function fits(chars: number, fontSize: number, sliceAngle: number): boolean {
  const length = chars * CHAR_WIDTH * fontSize;
  if (length > LABEL_OUTER - LABEL_INNER) return false;
  // At the inner end the slice is narrowest. The label needs its height there, with a little air.
  const innerWidth = 2 * (LABEL_OUTER - length) * Math.sin(rad(sliceAngle / 2));
  return innerWidth >= fontSize * 1.2;
}

/**
 * `rotation` is how far the wheel has turned (degrees, clockwise). The label is flipped by the place
 * where its slice rests on the screen, so after any spin every label reads left to right.
 */
export function sliceGeometry(count: number, index: number, label: string, rotation = 0): SliceGeometry {
  if (!Number.isInteger(count) || count < 2) throw new Error("A wheel needs at least 2 segments");
  const angle = 360 / count;
  const from = index * angle;
  const to = (index + 1) * angle;
  const mid = from + angle / 2;

  let text = label;
  let fontSize = MIN_FONT;
  let found = false;
  for (let f = MAX_FONT; f >= MIN_FONT; f -= 0.5) {
    if (fits(text.length, f, angle)) {
      fontSize = f;
      found = true;
      break;
    }
  }
  if (!found) {
    // Even the smallest size is too long: keep the largest cut that fits, ending in "...".
    let k = text.length;
    while (k > 1 && !fits(k, MIN_FONT, angle)) k -= 1;
    text = k >= 5 ? `${label.slice(0, k - 3)}...` : label.slice(0, k);
    fontSize = MIN_FONT;
  }
  return {
    from,
    to,
    mid,
    text,
    fontSize,
    flip: isLeftHalf(mid + rotation),
    length: text.length * CHAR_WIDTH * fontSize,
  };
}
