import type { BuildTimings } from "#/db/diff-json";
import { formatDuration } from "#/lib/format";

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

/** Under this many builds a p99 is the slowest wearing a percentile's name (PS-336): no number is shown. */
export const P99_MIN_BUILDS = 100;

/** The same gate for one build's or one window's compares, which come in far larger numbers. */
export const P99_MIN_COMPARES = 500;

/**
 * One step's median and its tail (ms) over `n` builds that have the step. The tail is the 95th
 * percentile, or the slowest (`max`) when `n` is under `P95_MIN_BUILDS`: with so few builds a p95
 * is the slowest in all but name, and the page says so. `p99` is null under its own, harder gate.
 */
export type StepStats = {
  p50: number;
  p95: number;
  p99: number | null;
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

/** The stats of `n` values from their nearest-rank percentiles, with both gates applied. */
export function gatedStats(
  { p50, p95, p99, max, n }: { p50: number; p95: number; p99: number; max: number; n: number },
  p99Min: number,
): StepStats {
  return {
    p50,
    p95,
    p99: n < p99Min ? null : p99,
    max,
    n,
    tail: n < P95_MIN_BUILDS ? "max" : "p95",
  };
}

export function statsOf(
  values: (number | null)[],
  p99Min: number = P99_MIN_BUILDS,
): StepStats | null {
  const sorted = values.filter((v): v is number => v !== null).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return gatedStats(
    {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? 0,
      n: sorted.length,
    },
    p99Min,
  );
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

/** One line of the CLI's speed profile on the build page: a label and the sentence under it. */
type ProfileRow = { key: string; label: string; text: string };

const dur = (ms: number) => formatDuration(ms, { exact: true });

/** A part's share of the workers' capture time, in whole percent; "<1%" where it rounds to 0. */
function share(part: number, whole: number): string {
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function captureWallRow(t: BuildTimings): ProfileRow[] {
  if (t.captureWallMs === undefined) return [];
  const worker = t.captureMs === undefined ? "" : ` against ${dur(t.captureMs)} of worker time`;
  const n = t.workers?.capture;
  const on = n === undefined ? "" : `, on ${plural(n, "worker", "workers")}`;
  return [
    { key: "capture-wall", label: "Capture wall", text: `${dur(t.captureWallMs)}${worker}${on}` },
  ];
}

const PART_LABELS = [
  ["setupMs", "setup"],
  ["navigateMs", "navigate"],
  ["settleMs", "settle"],
  ["screenshotMs", "screenshot"],
  ["measureMs", "measure"],
] as const;

const SETTLE_LABELS = [
  ["fontsMs", "fonts"],
  ["imagesMs", "images"],
  ["networkIdleMs", "network idle"],
  ["framesMs", "frames"],
] as const;

function capturePartsRow(t: BuildTimings): ProfileRow[] {
  const whole = t.captureMs;
  if (!whole) return [];
  const parts = PART_LABELS.flatMap(([key, label]) => {
    const ms = t[key];
    if (ms === undefined) return [];
    if (key !== "settleMs") return [`${label} ${share(ms, whole)}`];
    // The settle wait split by condition, and the story's own render wait, are inside it.
    const inside = [
      ...(t.settle
        ? SETTLE_LABELS.map(([k, name]) => `${name} ${share(t.settle?.[k] ?? 0, whole)}`)
        : []),
      ...(t.storyMs === undefined ? [] : [`story ${share(t.storyMs, whole)}`]),
    ];
    return [
      inside.length > 0
        ? `settle ${share(ms, whole)} (${inside.join(", ")})`
        : `settle ${share(ms, whole)}`,
    ];
  });
  if (parts.length === 0) return [];
  return [
    {
      key: "capture-parts",
      label: "Capture parts",
      text: `${parts.join(", ")}, of worker time`,
    },
  ];
}

function requestRows(t: BuildTimings): ProfileRow[] {
  return (t.upload?.batches ?? []).flatMap((b) => {
    if (b.p50Ms === undefined || b.p90Ms === undefined) return [];
    const max = b.maxMs === undefined ? "" : `, max ${dur(b.maxMs)}`;
    const wall = b.wallMs === undefined ? "" : `, ${dur(b.wallMs)} wall`;
    const workers =
      b.step === "upload" && t.workers?.upload
        ? ` on ${plural(t.workers.upload, "worker", "workers")}`
        : "";
    return [
      {
        key: `requests-${b.step.replaceAll(/\W+/g, "-")}`,
        label: `${b.step.charAt(0).toUpperCase()}${b.step.slice(1)} requests`,
        text: `${plural(b.count, "request", "requests")}${workers}: p50 ${dur(b.p50Ms)}, p90 ${dur(b.p90Ms)}${max}${wall}`,
      },
    ];
  });
}

function hostRow(t: BuildTimings): ProfileRow[] {
  if (!t.host) return [];
  const { cores, loadStart, loadEnd } = t.host;
  return [
    {
      key: "host",
      label: "Host",
      text: `${plural(cores, "core", "cores")}, load ${loadStart} at the start and ${loadEnd} at the end`,
    },
  ];
}

/**
 * What the CLI's timings say beyond its step totals: the capture's wall clock against the
 * workers' time, where that time went, how long each kind of request took, and the machine's cores
 * and load. A row whose figures the CLI did not send is left out, so a build from an older CLI
 * shows none.
 */
export function cliProfileRows(timings: BuildTimings | null): ProfileRow[] {
  if (!timings) return [];
  return [
    ...captureWallRow(timings),
    ...capturePartsRow(timings),
    ...requestRows(timings),
    ...hostRow(timings),
  ];
}
