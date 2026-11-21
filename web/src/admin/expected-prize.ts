/** The expected prize of a wheel, and the plain sentence about the limit. Integer sums, one division for display. */

export interface WeightedSegment {
  coins: number;
  weight: number;
}

export interface Expected {
  /** Sum of coins * weight. An integer. */
  weighted: number;
  /** Sum of weights. An integer. */
  totalWeight: number;
}

export function expectedParts(segments: readonly WeightedSegment[]): Expected {
  let weighted = 0;
  let totalWeight = 0;
  for (const s of segments) {
    weighted += s.coins * s.weight;
    totalWeight += s.weight;
  }
  return { weighted, totalWeight };
}

/** For display only: one division, rounded to 2 places. Null when there is no weight. */
export function expectedPrize(segments: readonly WeightedSegment[]): number | null {
  const { weighted, totalWeight } = expectedParts(segments);
  if (totalWeight === 0) return null;
  return Math.round((weighted * 100) / totalWeight) / 100;
}

/** The share of a segment in percent, with one decimal. */
export function sharePercent(weight: number, totalWeight: number): string {
  return totalWeight === 0 ? "0.0" : (Math.round((weight * 1000) / totalWeight) / 10).toFixed(1);
}

/** At or below the limit, decided without a division: weighted <= limit * totalWeight. */
export function withinLimit(segments: readonly WeightedSegment[], limit: number): boolean {
  const { weighted, totalWeight } = expectedParts(segments);
  return totalWeight > 0 && weighted <= limit * totalWeight;
}

export function limitSentence(segments: readonly WeightedSegment[], limit: number): string {
  if (withinLimit(segments, limit)) return "Within the limit: this change will be applied at once.";
  return `Above the limit of ${limit}: this change will wait for the platform team.`;
}

export interface EditableSegment {
  label: string;
  coins: number;
  weight: number;
}

/** The checks the server makes (2..24 segments, label 1..40, coins and weight whole numbers 1..1000000). */
export function segmentProblems(segments: readonly EditableSegment[]): string[] {
  const problems: string[] = [];
  if (segments.length < 2 || segments.length > 24) problems.push("The wheel needs 2 to 24 segments.");
  segments.forEach((s, i) => {
    const row = `Row ${i + 1}`;
    if (s.label.length < 1 || s.label.length > 40)
      problems.push(`${row}: the label needs 1 to 40 characters.`);
    if (!Number.isInteger(s.coins) || s.coins < 1 || s.coins > 1_000_000)
      problems.push(`${row}: coins must be a whole number from 1 to 1000000.`);
    if (!Number.isInteger(s.weight) || s.weight < 1 || s.weight > 1_000_000)
      problems.push(`${row}: weight must be a whole number from 1 to 1000000.`);
  });
  return problems;
}
