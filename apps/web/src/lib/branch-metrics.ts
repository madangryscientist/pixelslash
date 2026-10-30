import { wallMs } from "./run-metrics";
import { type StepStats, statsOf } from "./timings";

/**
 * The branch page's metrics (PS-233), free of the database: its last builds' wall times and
 * compares. Every figure is derived from what the server stored; a build that stored none is left
 * out of that figure and the `n` beside it says so.
 */

/** The page reads a branch's newest builds, this many. */
export const BRANCH_WINDOW = 20;

/** One build of the window: its two stored moments and its shots' stored compare times. */
export type BranchBuildRow = {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  /** Shots measured against their baseline on this build, by the server or by CI. */
  compares: number;
  /** The server's compare time of each shot that has one. */
  compareMs: number[];
};

/** One point of the wall-time trend, oldest first. */
export type WallPoint = { id: string; ms: number };

export type BranchMetrics = {
  /** The window's size, as the page states it ("last 20 builds"). */
  window: number;
  /** Builds in the window: the branch's builds, up to `window`. */
  builds: number;
  /** Build wall time over the builds that finished; null when none has. */
  wall: StepStats | null;
  /** The finished builds' wall times, oldest first: the trend's points. */
  trend: WallPoint[];
  /** Compares over every build of the window. */
  compares: number;
  /** Per-compare time over the shots the server timed; null when it timed none. */
  compareTime: StepStats | null;
};

/** The window's metrics; `rows` are the window's builds in any order. */
export function branchMetrics(rows: readonly BranchBuildRow[]): BranchMetrics {
  const ordered = rows.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const trend = ordered.flatMap((row) => {
    const ms = wallMs(row);
    return ms === null ? [] : [{ id: row.id, ms }];
  });
  return {
    window: BRANCH_WINDOW,
    builds: rows.length,
    wall: statsOf(trend.map((p) => p.ms)),
    trend,
    compares: rows.reduce((n, row) => n + row.compares, 0),
    compareTime: statsOf(rows.flatMap((row) => row.compareMs)),
  };
}

/**
 * The trend as an SVG polyline's points in a `width` × `height` box: oldest at the left, the
 * slowest at the top. Only for three points or more; two are shown as their values.
 */
export function sparkPoints(trend: readonly WallPoint[], width: number, height: number): string {
  if (trend.length < 3) return "";
  const values = trend.map((p) => p.ms);
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const step = width / (trend.length - 1);
  return values
    .map((ms, i) => `${round(i * step)},${round(height - ((ms - lo) / span) * height)}`)
    .join(" ");
}

const round = (n: number) => Math.round(n * 10) / 10;
