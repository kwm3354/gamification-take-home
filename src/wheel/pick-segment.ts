import { createHmac } from "node:crypto";

export interface Segment {
  label: string;
  coins: number;
  weight: number;
}

/**
 * The outcome of a spin. It depends only on the tenant's secret, the spin id and the segment table,
 * so the client cannot choose it and the same spin always gives the same answer.
 * n = first 8 bytes of HMAC-SHA256(wheelSecret, spinId) as an unsigned integer, mod the sum of weights.
 */
export function pickSegment(wheelSecret: string, spinId: string, segments: Segment[]): number {
  if (segments.length === 0) throw new Error("a wheel needs at least one segment");
  let total = 0n;
  for (const s of segments) {
    if (!Number.isInteger(s.weight) || s.weight <= 0) {
      throw new Error("segment weights must be positive integers");
    }
    total += BigInt(s.weight);
  }
  const n = createHmac("sha256", wheelSecret).update(spinId).digest().readBigUInt64BE(0) % total;
  let upTo = 0n;
  for (let i = 0; i < segments.length; i++) {
    upTo += BigInt((segments[i] as Segment).weight);
    if (n < upTo) return i;
  }
  throw new Error("unreachable: n is below the total weight");
}
