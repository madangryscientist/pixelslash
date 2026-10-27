/**
 * The arithmetic of a build's server timings (ob 1792), free of the database so the build page and
 * the org's Timings page share it.
 */

/**
 * The steps a build is timed in; `total` runs from the diff's claim to the last step's end (the
 * diff, the explanations and the summary), and leaves the wait (`queue`, "before diff") out.
 */
export const STEPS = ["queue", "diff", "explain", "summary", "total"] as const;
export type Step = (typeof STEPS)[number];

/** How the server's steps read, on the build page and as the Timings tab's column heads. */
export const STEP_LABELS: Record<Step, string> = {
  queue: "before diff",
  diff: "diff",
  explain: "AI explanations",
  summary: "AI summary",
  total: "total from diff start",
};

/** The Timings tab's account of its Total column; the build page's label says the same in short. */
export const TOTAL_EXPLAINED =
  "Total runs from the diff starting to the last step ending (the diff, the AI explanations and the AI summary); it leaves Before diff out.";

/** On a build the server ran more than once; its numbers are the last run's alone. */
export const RERUN_NOTE =
  "of the latest run only: the build took more than one run (a diff that ran out of the server's time budget and resumed, or a shot re-diffed)";

/** The CLI's total is the clock on the wall, not a sum, so steps that overlap can add up to more. */
export const CLI_TOTAL_NOTE =
  "CLI total is wall-clock time, so it can be less than its steps added up";

/** Said beside an AI summary step that ran but stored no summary: the step timed a skip, not a model call. */
export const SUMMARY_SKIPPED_NOTE = "no summary written (skipped or failed)";

/** The tail of a step's times is a 95th percentile only over this many builds; fewer, and it is the slowest. */
export const P95_MIN_BUILDS = 20;

/**
 * One step's median and its tail (ms) over `n` builds that have the step. The tail is the 95th
 * percentile, or the slowest (`max`) when `n` is under `P95_MIN_BUILDS`: with so few builds a p95
 * is the slowest in all but name, and the page says so.
 */
export type StepStats = {
  p50: number;
  p95: number;
  max: number;
  n: number;
  tail: "p95" | "max";
};

/**
 * The nearest-rank percentile of an ascending list: the ceil(p · n)-th value, so p95 of 20 builds
 * is the 19th and the slowest is never hidden by interpolation. `sorted` must not be empty.
 */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

export function statsOf(values: (number | null)[]): StepStats | null {
  const sorted = values.filter((v): v is number => v !== null).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    n: sorted.length,
    tail: sorted.length < P95_MIN_BUILDS ? "max" : "p95",
  };
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

/**
 * The build's run from claim to its last server step; null when it has no start or no end, or when
 * the end is before the start (a clock that stepped back): a span that is not one is no total, and
 * a 0 would be counted as a build that finished instantly.
 */
export function totalMs(build: TimedBuild): number | null {
  if (!build.finishedAt || !build.processingStartedAt) return null;
  const span = build.finishedAt.getTime() - build.processingStartedAt.getTime();
  return span < 0 ? null : span;
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

/** One figure on the build page's Server or CLI line. */
export type StepRow = { key: string; label: string; ms: number; note?: string };

/** The server's steps of a build, those that ran. `summarised`: the build stored an AI summary. */
export function serverStepRows(build: TimedBuild, summarised: boolean): StepRow[] {
  const all: [Step, number | null][] = [
    ["queue", build.queueMs],
    ["diff", build.diffMs],
    ["explain", build.explainMs],
    ["summary", build.summaryMs],
    ["total", totalMs(build)],
  ];
  return all.flatMap(([key, ms]) => {
    if (ms === null) return [];
    const row: StepRow = { key, label: STEP_LABELS[key], ms };
    if (key === "summary" && !summarised) row.note = SUMMARY_SKIPPED_NOTE;
    return [row];
  });
}

/** What the CLI sent of its own timings (`BuildTimings` in the diff JSON). */
export type CliTimings = {
  totalMs: number;
  captureMs?: number;
  diffMs?: number;
  judgeMs?: number;
  upload?: { totalMs: number };
};

/** The CLI's steps, those it reported. */
export function cliStepRows(timings: CliTimings | null): StepRow[] {
  if (!timings) return [];
  const all: [string, string, number | undefined][] = [
    ["capture", "capture", timings.captureMs],
    ["diff", "diff", timings.diffMs],
    ["judge", "judge", timings.judgeMs],
    ["upload", "upload", timings.upload?.totalMs],
    ["total", "total", timings.totalMs],
  ];
  return all.flatMap(([key, label, ms]) => (ms === undefined ? [] : [{ key, label, ms }]));
}
