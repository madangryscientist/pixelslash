import type { Composition } from "@pixelslash/engine/composition-entry";
import { and, count, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
  SNAPSHOT_GROUPS,
  type SnapshotGroup,
  awaitsDecision,
  groupOf,
  skippedFlaky,
} from "#/lib/snapshot-groups";
import { STALE_FAILURE, explaining } from "#/ai/explain-pending";
import { type ApprovedEarlier, approvedEarlier } from "./approved-earlier";
import { inChunks } from "./chunks";
import { notSkippedFlaky } from "./markers";
import { carriedRootBuilds, decideGroup, groupOfShot, groupsOfBuild } from "./carried";
import { type Db, NotFoundError } from "./db";
import {
  type AiReview,
  type DiffLocation,
  type DiffOptions,
  type DiffResult,
  type DiffStatus,
  type FlakyPolicy,
  type IgnoreRect,
  type ReviewState,
  builds,
  snapshots,
  users,
} from "./schema";

/**
 * Build status after the diff (ob 1470, review model 1422). A changed shot blocks until it is
 * accepted or rejected, and so does an unchanged one that carries a change still open on the
 * branch's previous build (ob 1712); new and removed shots never block; any rejection fails the
 * build until a new build arrives. `passed` therefore means "nothing left to decide", not "no
 * differences".
 */
export type Verdict = "changes" | "passed" | "failed";

export function verdictOf(rows: Parameters<typeof awaitsDecision>[0][]): Verdict {
  if (rows.some((row) => row.reviewState === "rejected")) return "failed";
  if (rows.some(awaitsDecision)) return "changes";
  return "passed";
}

export async function refreshBuildStatus(db: Db, buildId: string): Promise<Verdict> {
  const rows = await db
    .select({
      diffStatus: snapshots.diffStatus,
      reviewState: snapshots.reviewState,
      carriedFrom: snapshots.carriedFrom,
      flakeId: snapshots.flakeId,
      flakyPolicy: snapshots.flakyPolicy,
    })
    .from(snapshots)
    .where(eq(snapshots.buildId, buildId));
  const status = verdictOf(rows);
  await db.update(builds).set({ status }).where(eq(builds.id, buildId));
  return status;
}

async function refreshBuilds(db: Db, buildIds: string[]): Promise<void> {
  for (const buildId of buildIds) await refreshBuildStatus(db, buildId);
}

/** A build still uploading, processing or errored has no verdict to review. */
export class NotReviewableError extends Error {
  constructor(status: string) {
    super(`build is ${status}: only a diffed build can be reviewed`);
    this.name = "NotReviewableError";
  }
}

export type SnapshotView = {
  id: string;
  name: string;
  platform: string;
  browser: string;
  viewport: string;
  theme: string;
  tags: string[];
  diffStatus: DiffStatus | null;
  reviewState: ReviewState;
  /** The reviewer's GitHub login, when someone accepted or rejected it. */
  reviewedBy: string | null;
  reviewedAt: Date | null;
  diffOptions: DiffOptions;
  /** What the server diff measured with, and where each value came from (ob 1495). */
  resolvedDiff: (typeof snapshots.$inferSelect)["resolvedDiff"];
  ignore: IgnoreRect[];
  imageKey: string;
  baselineKey: string | null;
  diffKey: string | null;
  diffResult: DiffResult | null;
  rebaselineNeeded: boolean;
  /**
   * The shot whose open change this one carries (ob 1712): it is identical to the branch's previous
   * shot, which still waits for a decision. With the build that holds it, for a link.
   */
  carriedFrom: string | null;
  /** The build that holds `carriedFrom`; null when that shot is gone. */
  carriedFromBuild: string | null;
  /** Set on an unchanged shot whose difference from the default branch was accepted on an earlier build of this branch. */
  approvedEarlier: ApprovedEarlier | null;
  /** Where the diff ran (ob 1727): the CI job's CLI or this server; null until measured. */
  measuredBy: DiffLocation | null;
  /** The engine that measured it; null until measured. */
  engineVersion: string | null;
  /** The server's compare time for it (PS-233); read through `compareMsOf`, which drops a stale one. */
  diffMs: number | null;
  /** Why the shot could not be measured, when it could not. */
  diffError: string | null;
  /** The flake it is labelled with (ob 1724): detected on upload, open for its key, or marked. */
  flakeId: string | null;
  /** The flaky policy its config sent; null is `review`. */
  flakyPolicy: FlakyPolicy | null;
  /** Against main (ob 1723): null status is not measured against main (see the schema). */
  mainBaselineKey: string | null;
  mainDiffStatus: DiffStatus | null;
  mainDiffResult: DiffResult | null;
  /** The change in words, from the judge; null when nothing described it. */
  changeNote: string | null;
  /** A composition-only project's gaps and special cases (ob 1850); null for any other project. */
  composition: Composition | null;
  /** The project model's label and sentence per changed region (ob 1473); null when none was given. */
  aiReview: AiReview | null;
  /** Queued for the model and not yet answered (ob 1875). */
  aiPending: boolean;
  /** Why the model has no explanation for it, when it tried and failed (ob 1875). */
  aiError: string | null;
  createdAt: Date;
};

export type BuildView = {
  build: typeof builds.$inferSelect;
  /** Ordered as the review walks them: changed, new, removed, unchanged, re-baseline, unmeasured. */
  snapshots: SnapshotView[];
  /** The build's summary is waiting on its shots' explanations (ob 1875). */
  summaryPending: boolean;
};

/**
 * One build and its shots, scoped to the project: another project's build is the same 404 as a
 * missing one. Only the fields the screens draw are selected; blobs are not read here.
 */
export async function buildView(db: Db, projectId: string, buildId: string): Promise<BuildView> {
  const [build] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.projectId, projectId)));
  if (!build) throw new NotFoundError("build");
  const rows = await db
    .select({
      id: snapshots.id,
      name: snapshots.name,
      platform: snapshots.platform,
      browser: snapshots.browser,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      tags: snapshots.tags,
      diffStatus: snapshots.diffStatus,
      reviewState: snapshots.reviewState,
      reviewedAt: snapshots.reviewedAt,
      reviewer: users.login,
      diffOptions: snapshots.diffOptions,
      resolvedDiff: snapshots.resolvedDiff,
      ignore: snapshots.ignore,
      imageKey: snapshots.imageKey,
      baselineKey: snapshots.baselineKey,
      diffKey: snapshots.diffKey,
      diffResult: snapshots.diffResult,
      rebaselineNeeded: snapshots.rebaselineNeeded,
      carriedFrom: snapshots.carriedFrom,
      measuredBy: snapshots.measuredBy,
      engineVersion: snapshots.engineVersion,
      diffMs: snapshots.diffMs,
      diffError: snapshots.diffError,
      flakeId: snapshots.flakeId,
      flakyPolicy: snapshots.flakyPolicy,
      mainBaselineKey: snapshots.mainBaselineKey,
      mainDiffStatus: snapshots.mainDiffStatus,
      mainDiffResult: snapshots.mainDiffResult,
      changeNote: snapshots.changeNote,
      composition: snapshots.composition,
      aiReview: snapshots.aiReview,
      aiQueuedAt: snapshots.aiQueuedAt,
      aiError: snapshots.aiError,
      createdAt: snapshots.createdAt,
    })
    .from(snapshots)
    .leftJoin(users, eq(users.id, snapshots.reviewedBy))
    .where(eq(snapshots.buildId, buildId));
  const approved = await approvedEarlier(db, build);
  const roots = await carriedRootBuilds(db, buildId);
  const now = Date.now();
  const ordered = rows
    .map(({ reviewer, aiQueuedAt, ...row }) => ({
      ...row,
      aiPending: explaining(aiQueuedAt, now),
      // Queued so long ago that its consumer died: named, not left explaining.
      aiError: row.aiError ?? (aiQueuedAt && !explaining(aiQueuedAt, now) ? STALE_FAILURE : null),
      reviewedBy: reviewer,
      carriedFromBuild: (row.carriedFrom && roots.get(row.carriedFrom)) ?? null,
      approvedEarlier: approved.get(row.id) ?? null,
    }))
    .toSorted(
      (a, b) =>
        SNAPSHOT_GROUPS.indexOf(groupOf(a)) - SNAPSHOT_GROUPS.indexOf(groupOf(b)) ||
        a.name.localeCompare(b.name) ||
        a.platform.localeCompare(b.platform) ||
        a.browser.localeCompare(b.browser) ||
        a.viewport.localeCompare(b.viewport) ||
        a.theme.localeCompare(b.theme),
    );
  return { build, snapshots: ordered, summaryPending: explaining(build.aiSummaryQueuedAt, now) };
}

export type BuildCounts = Record<SnapshotGroup, number> & {
  pending: number;
  accepted: number;
  rejected: number;
  /** Shots that wait for a decision (`awaitsDecision`): what the build page calls "to review". */
  toReview: number;
  /** Flaky shots their config skips (`skippedFlaky`, ob 1724): counted on a line of their own. */
  skippedFlaky: number;
};

export const emptyCounts = (): BuildCounts => ({
  changed: 0,
  new: 0,
  removed: 0,
  unchanged: 0,
  rebaseline: 0,
  unmeasured: 0,
  pending: 0,
  accepted: 0,
  rejected: 0,
  toReview: 0,
  skippedFlaky: 0,
});

/** The grouped columns of `countBuilds`: each is selected and grouped by. */
const statColumns = {
  buildId: snapshots.buildId,
  diffStatus: snapshots.diffStatus,
  rebaselineNeeded: snapshots.rebaselineNeeded,
  reviewState: snapshots.reviewState,
  carried: isNotNull(snapshots.carriedFrom),
  flaky: isNotNull(snapshots.flakeId),
  flakyPolicy: snapshots.flakyPolicy,
};

/**
 * The per-group counts of each build's shots, in one grouped read per part of the ids (a project
 * page counts every build of the project). A build with no shots is absent.
 */
export async function countBuilds(db: Db, buildIds: string[]): Promise<Map<string, BuildCounts>> {
  const counts = new Map<string, BuildCounts>();
  const stats = await inChunks(buildIds, 0, (part) =>
    db
      .select({ ...statColumns, n: count() })
      .from(snapshots)
      .where(inArray(snapshots.buildId, part))
      .groupBy(...Object.values(statColumns)),
  );
  for (const stat of stats) {
    const held = counts.get(stat.buildId) ?? emptyCounts();
    held[groupOf(stat)] += stat.n;
    held[stat.reviewState] += stat.n;
    const row = { ...stat, carriedFrom: stat.carried ? "" : null, flakeId: stat.flaky ? "" : null };
    if (awaitsDecision(row)) held.toReview += stat.n;
    if (skippedFlaky(row)) held.skippedFlaky += stat.n;
    counts.set(stat.buildId, held);
  }
  return counts;
}

async function reviewableBuildId(db: Db, projectId: string, buildId: string): Promise<string> {
  const [row] = await db
    .select({ id: builds.id, status: builds.status })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.projectId, projectId)));
  if (!row) throw new NotFoundError("build");
  if (row.status !== "changes" && row.status !== "passed") throw new NotReviewableError(row.status);
  return row.id;
}

async function reviewableSnapshot(
  db: Db,
  projectId: string,
  snapshotId: string,
): Promise<{ buildId: string; carriedFrom: string | null }> {
  const [row] = await db
    .select({
      buildId: snapshots.buildId,
      carriedFrom: snapshots.carriedFrom,
      status: builds.status,
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.id, snapshotId), eq(builds.projectId, projectId)));
  if (!row) throw new NotFoundError("snapshot");
  if (row.status !== "changes" && row.status !== "passed") throw new NotReviewableError(row.status);
  return row;
}

/** Record one reviewer's decision on one shot and move the build to its verdict. */
export async function reviewSnapshot(
  db: Db,
  input: {
    projectId: string;
    snapshotId: string;
    state: "accepted" | "rejected";
    userId: string;
  },
): Promise<Verdict> {
  const shot = await reviewableSnapshot(db, input.projectId, input.snapshotId);
  const decision = { reviewState: input.state, reviewedBy: input.userId, reviewedAt: new Date() };
  await db.update(snapshots).set(decision).where(eq(snapshots.id, input.snapshotId));
  const group = groupOfShot(shot.carriedFrom ?? input.snapshotId);
  await refreshBuilds(db, await decideGroup(db, input.projectId, group, decision));
  return refreshBuildStatus(db, shot.buildId);
}

/**
 * Accept every shot of the build, recording who and when. A rejection is never undone — a
 * rejected build is not reviewable at all, so accepting cannot mask it; the build stays failed
 * until a new build arrives. The acceptance reaches the other builds' shots that carry the same
 * change (`decideGroup`).
 */
export async function acceptAllSnapshots(
  db: Db,
  input: { projectId: string; buildId: string; userId: string },
): Promise<Verdict> {
  const buildId = await reviewableBuildId(db, input.projectId, input.buildId);
  const decision = {
    reviewState: "accepted",
    reviewedBy: input.userId,
    reviewedAt: new Date(),
  } as const;
  await db
    .update(snapshots)
    .set(decision)
    // A skipped flaky shot is never accepted in bulk (ob 1724): its baseline does not move.
    .where(
      and(eq(snapshots.buildId, buildId), ne(snapshots.reviewState, "accepted"), notSkippedFlaky()),
    );
  const group = groupsOfBuild(db, buildId);
  await refreshBuilds(db, await decideGroup(db, input.projectId, group, decision));
  return refreshBuildStatus(db, buildId);
}
