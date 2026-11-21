export type FaultPoint = "a.grant" | "a.find" | "b.grant" | "b.find" | "b.callback";

const grantFaults = ["error_500", "rate_limit", "refuse", "lost_request", "lost_answer", "slow_answer"];
const findFaults = ["error_500", "rate_limit", "lost_request", "slow_answer"];

export const validFaults: Record<FaultPoint, string[]> = {
  "a.grant": grantFaults,
  "a.find": findFaults,
  "b.grant": grantFaults,
  "b.find": findFaults,
  "b.callback": ["lost", "twice", "delay"],
};

export interface ScriptedFault {
  point: FaultPoint;
  fault: string;
  times: number;
  delayMs?: number;
  tenantId?: string;
}

export interface AppliedFault {
  fault: string;
  delayMs: number;
}

export type ChaosRates = Record<string, Record<string, number>>;

/** Small seeded generator. Same seed, same numbers. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Faults {
  private queue: ScriptedFault[] = [];
  private chaos: { rng: () => number; rates: ChaosRates } | null = null;

  add(rule: ScriptedFault): void {
    this.queue.push({ ...rule });
  }

  list(): ScriptedFault[] {
    return structuredClone(this.queue);
  }

  setChaos(seed: number | null, rates: ChaosRates): void {
    this.chaos = seed === null ? null : { rng: mulberry32(seed), rates };
  }

  clear(): void {
    this.queue = [];
    this.chaos = null;
  }

  /** Scripted faults win. Otherwise one random draw per call at a point that has chaos rates. */
  take(point: FaultPoint, tenantId: string): AppliedFault | null {
    const i = this.queue.findIndex(
      (f) => f.point === point && (f.tenantId === undefined || f.tenantId === tenantId),
    );
    if (i >= 0) {
      const rule = this.queue[i] as ScriptedFault;
      rule.times -= 1;
      if (rule.times <= 0) this.queue.splice(i, 1);
      return { fault: rule.fault, delayMs: rule.delayMs ?? 5000 };
    }
    const rates = this.chaos?.rates[point];
    if (!this.chaos || !rates) return null;
    const r = this.chaos.rng();
    let sum = 0;
    for (const [fault, rate] of Object.entries(rates)) {
      sum += rate;
      if (r < sum) return { fault, delayMs: 5000 };
    }
    return null;
  }
}
