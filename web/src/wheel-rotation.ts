/** Angles are in degrees, clockwise. The pointer is at the top. Slice 0 starts at the pointer. */

export const MIN_TURNS = 4;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * The rotation to give the wheel so that slice `segmentIndex` stops under the pointer.
 * The result is at least `MIN_TURNS` full turns above `currentRotation`, and less than one turn more.
 */
export function finalRotation(segmentCount: number, segmentIndex: number, currentRotation: number): number {
  if (!Number.isInteger(segmentCount) || segmentCount < 1) throw new Error("segmentCount must be >= 1");
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segmentCount) {
    throw new Error("segmentIndex is out of range");
  }
  const sliceAngle = 360 / segmentCount;
  // A wheel turned by R shows, under the pointer, the point at wheel angle -R.
  const target = mod(-(segmentIndex + 0.5) * sliceAngle, 360);
  const base = currentRotation + MIN_TURNS * 360;
  return base + mod(target - base, 360);
}

/** The slice under the pointer for a given rotation. */
export function sliceUnderPointer(segmentCount: number, rotation: number): number {
  return Math.floor(mod(-rotation, 360) / (360 / segmentCount));
}
