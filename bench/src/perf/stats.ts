/** Median, p95 and the before/after comparison of `bun run bench:perf` (ob 1790). No dependency. */

/** A head median more than this many percent above the base median, in the same run, fails the check. */
export const REGRESSION_PCT = 25;

export type Summary = { n: number; median: number; p95: number };

function sorted(xs: number[]): number[] {
  if (xs.length === 0) throw new Error("no samples");
  return xs.toSorted((a, b) => a - b);
}

export function median(xs: number[]): number {
  const s = sorted(xs);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Nearest rank: the smallest sample that at least `p` percent of the samples do not exceed. */
export function percentile(xs: number[], p: number): number {
  const s = sorted(xs);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
}

export function summarise(xs: number[]): Summary {
  return { n: xs.length, median: median(xs), p95: percentile(xs, 95) };
}

export type Comparison = {
  step: string;
  base: Summary;
  head: Summary;
  /** `(head - base) / base`, in percent; positive is slower. */
  changePct: number;
  regressed: boolean;
};

export function compare(step: string, base: Summary, head: Summary): Comparison {
  const changePct = base.median === 0 ? 0 : ((head.median - base.median) / base.median) * 100;
  return { step, base, head, changePct, regressed: changePct > REGRESSION_PCT };
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;

/** The line the check prints for a step that is too slow: the step and both medians. */
export function regressionLine(c: Comparison): string {
  return `${c.step}: head median ${ms(c.head.median)} is ${c.changePct.toFixed(1)}% slower than base median ${ms(c.base.median)} (limit ${REGRESSION_PCT}%)`;
}
