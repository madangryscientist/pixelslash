/**
 * The arithmetic of a build's server timings (ob 1792), free of the database so the build page and
 * the org's Timings page share it.
 */

/** The steps a build is timed in; `total` runs from the diff's claim to the last step's end (the diff, the explanations and the summary), and leaves the wait out. */
export const STEPS = ["queue", "diff", "explain", "summary", "total"] as const;
export type Step = (typeof STEPS)[number];

/** One step's median and 95th percentile (ms) over `n` builds that have the step. */
export type StepStats = { p50: number; p95: number; n: number };

/**
 * The nearest-rank percentile of an ascending list: the ceil(p · n)-th value, so p95 of 20 builds
 * is the 19th and the slowest is never hidden by interpolation. `sorted` must not be empty.
 */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

function statsOf(values: (number | null)[]): StepStats | null {
  const sorted = values.filter((v): v is number => v !== null).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), n: sorted.length };
}

/** A build's server timings, as stored. */
export type TimedBuild = {
  queueMs: number | null;
  diffMs: number | null;
  explainMs: number | null;
  summaryMs: number | null;
  finishedAt: Date | null;
  processingStartedAt: Date | null;
};

/** The build's run from claim to its last server step; null when it has no start or no end. */
export function totalMs(build: TimedBuild): number | null {
  if (!build.finishedAt || !build.processingStartedAt) return null;
  return Math.max(0, build.finishedAt.getTime() - build.processingStartedAt.getTime());
}

/** The stats of one project's builds. */
export function summarise(rows: readonly TimedBuild[]): Record<Step, StepStats | null> {
  return {
    queue: statsOf(rows.map((r) => r.queueMs)),
    diff: statsOf(rows.map((r) => r.diffMs)),
    explain: statsOf(rows.map((r) => r.explainMs)),
    summary: statsOf(rows.map((r) => r.summaryMs)),
    total: statsOf(rows.map(totalMs)),
  };
}
