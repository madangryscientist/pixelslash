import type {
  AiReview,
  AiSummary,
  AiUsage,
  DiffLocation,
  DiffStatus,
  FlakyPolicy,
} from "#/db/schema";
import { isMarker } from "#/db/markers";
import { type SnapshotGroup, groupOf, skippedFlaky } from "./snapshot-groups";
import { type StepStats, statsOf } from "./timings";

/**
 * The build page's "This run" card (PS-233), free of the database: what the build's stored rows
 * say about the run that made them. Every figure is stored by the server, sent by the CLI, or
 * derived from those; one that was never recorded is absent, never 0.
 */

/** Where a figure comes from, as the card says it. */
export type Source = "server" | "cli" | "derived";

/** A shot as the card reads it: the fields of `SnapshotView` it needs. */
export type MetricShot = {
  name: string;
  viewport: string;
  theme: string;
  diffStatus: DiffStatus | null;
  rebaselineNeeded: boolean;
  measuredBy: DiffLocation | null;
  diffMs: number | null;
  reviewState: string;
  reviewedBy: string | null;
  carriedFrom: string | null;
  flakeId: string | null;
  flakyPolicy: FlakyPolicy | null;
  aiReview: AiReview | null;
};

/** A build as the card reads it. */
export type MetricBuild = {
  branch: string;
  createdAt: Date;
  finishedAt: Date | null;
  aiSummary: AiSummary | null;
  timings: { shots: { name: string; diffMs?: number }[] } | null;
};

/** A shot measured against its baseline: what the card counts as one compare. */
const MEASURED: ReadonlySet<SnapshotGroup> = new Set(["changed", "unchanged"]);

export const compared = (shot: Pick<MetricShot, "diffStatus" | "rebaselineNeeded">) =>
  MEASURED.has(groupOf(shot));

/**
 * The compare time a shot has: stored when the server measured it and it still holds that result.
 * A result a re-run cleared, or one CI measured, has none.
 */
export const compareMsOf = (
  shot: Pick<MetricShot, "diffStatus" | "rebaselineNeeded" | "measuredBy" | "diffMs">,
): number | null => (compared(shot) && shot.measuredBy === "server" ? shot.diffMs : null);

/** The build's wall time: created to the last server step, derived from two stored moments. */
export function wallMs(build: Pick<MetricBuild, "createdAt" | "finishedAt">): number | null {
  if (!build.finishedAt) return null;
  const span = build.finishedAt.getTime() - build.createdAt.getTime();
  return span < 0 ? null : span;
}

export type RunCounts = {
  shots: number;
  compares: { server: number; ci: number };
  notMeasured: number;
  skippedFlaky: number;
  /** Only on the default branch, where a build is accepted on finalise; null elsewhere. */
  autoAccepted: number | null;
};

export function countRun(
  build: Pick<MetricBuild, "branch">,
  shots: readonly MetricShot[],
  defaultBranch: string,
): RunCounts {
  const held = shots.filter((s) => !isMarker(s));
  const measured = held.filter(compared);
  return {
    shots: held.length,
    compares: {
      server: measured.filter((s) => s.measuredBy === "server").length,
      ci: measured.filter((s) => s.measuredBy === "ci").length,
    },
    notMeasured: held.filter((s) => groupOf(s) === "unmeasured").length,
    skippedFlaky: held.filter(skippedFlaky).length,
    autoAccepted:
      build.branch === defaultBranch
        ? held.filter((s) => s.reviewState === "accepted" && s.reviewedBy === null).length
        : null,
  };
}

/** A shot's time on the slowest list, by its name and variant. */
export type SlowShot = { label: string; ms: number };

/** The build's compare times: their stats, the three slowest, and who recorded them. */
export type CompareTimes = { stats: StepStats; slowest: SlowShot[]; source: Source };

const labelOf = (s: { name: string; viewport?: string; theme?: string }) =>
  s.viewport && s.theme ? `${s.name} (${s.viewport}, ${s.theme})` : s.name;

function timesOf(timed: SlowShot[], source: Source): CompareTimes | null {
  const stats = statsOf(timed.map((t) => t.ms));
  if (!stats) return null;
  const slowest = timed.toSorted((a, b) => b.ms - a.ms).slice(0, 3);
  return { stats, slowest, source };
}

/**
 * Per-compare time: the server's, stored per shot, or else what the CLI sent per shot (a CI build
 * diffs on the runner). Null when neither recorded one.
 */
export function compareTimes(
  build: Pick<MetricBuild, "timings">,
  shots: readonly MetricShot[],
): CompareTimes | null {
  const server = shots.flatMap((s) => {
    const ms = compareMsOf(s);
    return ms === null ? [] : [{ label: labelOf(s), ms }];
  });
  if (server.length > 0) return timesOf(server, "server");
  const cli = (build.timings?.shots ?? []).flatMap((s) =>
    s.diffMs === undefined ? [] : [{ label: labelOf(s), ms: s.diffMs }],
  );
  return timesOf(cli, "cli");
}

/** The model's tokens on a build: its explanations' and its summary's, each null when none ran. */
export type RunTokens = {
  explain: (AiUsage & { unrecorded: number }) | null;
  summary: AiUsage | null;
};

/** The tokens the stored explanations and summary reported. A failed call stored none. */
export function runTokens(
  build: Pick<MetricBuild, "aiSummary">,
  shots: readonly MetricShot[],
): RunTokens {
  const reviews = shots.flatMap((s) => (s.aiReview ? [s.aiReview] : []));
  const usages = reviews.flatMap((r) => (r.usage ? [r.usage] : []));
  const unrecorded = reviews.length - usages.length;
  const reported = usages.some((u) => u.reported > 0);
  const counted = (key: "input" | "output" | "total") => (reported ? sum(usages, key) : null);
  const explain =
    usages.length > 0
      ? {
          calls: sum(usages, "calls"),
          reported: sum(usages, "reported"),
          input: counted("input"),
          output: counted("output"),
          total: counted("total"),
          unrecorded,
        }
      : null;
  return { explain, summary: build.aiSummary?.usage ?? null };
}

const sum = (usages: AiUsage[], key: keyof AiUsage) =>
  usages.reduce((n, u) => n + (u[key] ?? 0), 0);
