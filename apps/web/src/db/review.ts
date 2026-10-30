import type { A11yDiff } from "@hackcove/pixelslash-engine/a11y-entry";
import type { Composition } from "@hackcove/pixelslash-engine/composition-entry";
import { and, eq, ne } from "drizzle-orm";
import { SNAPSHOT_GROUPS, awaitsDecision, reviewGroupOf } from "#/lib/snapshot-groups";
import { STALE_FAILURE, explaining } from "#/ai/explain-pending";
import { type ApprovedEarlier, approvedEarlier } from "./approved-earlier";
import { notSkippedFlaky } from "./markers";
import { a11yDiffsOf } from "./review-a11y";
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
 * branch's previous build (ob 1712) or one that differs from main and was never accepted (PS-284). A
 * new shot waits like a change (PS-284); removed shots never block; any rejection fails the build
 * until a new build arrives. `passed` therefore means "nothing left to decide", not "no
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

/** A decision's outcome: the decided build's verdict, and every build whose status it refreshed. */
export type Decided = { verdict: Verdict; buildIds: string[] };

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
  /**
   * The scan against the baseline's, split into new and already there. `off` when this shot was
   * not scanned, `unbaselined` when the baseline was not (or there is none), so nothing is called new.
   */
  a11yDiff: A11yDiff;
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
      a11y: snapshots.a11y,
      baselineSnapshotId: snapshots.baselineSnapshotId,
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
  const a11yDiffs = await a11yDiffsOf(db, rows);
  const now = Date.now();
  const ordered = rows
    .map(({ reviewer, aiQueuedAt, a11y: _scan, baselineSnapshotId: _baseline, ...row }) => ({
      ...row,
      a11yDiff: a11yDiffs.get(row.id) ?? { state: "off" as const },
      aiPending: explaining(aiQueuedAt, now),
      // Queued so long ago that its consumer died: named, not left explaining.
      aiError: row.aiError ?? (aiQueuedAt && !explaining(aiQueuedAt, now) ? STALE_FAILURE : null),
      reviewedBy: reviewer,
      carriedFromBuild: (row.carriedFrom && roots.get(row.carriedFrom)) ?? null,
      approvedEarlier: approved.get(row.id) ?? null,
    }))
    .toSorted(
      (a, b) =>
        SNAPSHOT_GROUPS.indexOf(reviewGroupOf(a)) - SNAPSHOT_GROUPS.indexOf(reviewGroupOf(b)) ||
        a.name.localeCompare(b.name) ||
        a.platform.localeCompare(b.platform) ||
        a.browser.localeCompare(b.browser) ||
        a.viewport.localeCompare(b.viewport) ||
        a.theme.localeCompare(b.theme),
    );
  return { build, snapshots: ordered, summaryPending: explaining(build.aiSummaryQueuedAt, now) };
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

type ShotDecision = {
  projectId: string;
  snapshotId: string;
  state: "accepted" | "rejected";
  userId: string;
};

/** Record one reviewer's decision on one shot and move the build to its verdict. */
export async function reviewSnapshot(db: Db, input: ShotDecision): Promise<Verdict> {
  return (await decideShot(db, input)).verdict;
}

/** `reviewSnapshot`, also naming the builds it moved: the carried shots' builds as well (PS-23). */
export async function decideShot(db: Db, input: ShotDecision): Promise<Decided> {
  const shot = await reviewableSnapshot(db, input.projectId, input.snapshotId);
  const decision = { reviewState: input.state, reviewedBy: input.userId, reviewedAt: new Date() };
  await db.update(snapshots).set(decision).where(eq(snapshots.id, input.snapshotId));
  const group = groupOfShot(shot.carriedFrom ?? input.snapshotId);
  const moved = await decideGroup(db, input.projectId, group, decision);
  await refreshBuilds(db, moved);
  const verdict = await refreshBuildStatus(db, shot.buildId);
  return { verdict, buildIds: [shot.buildId, ...moved] };
}

/**
 * Accept every shot of the build, recording who and when. A rejection is never undone — a
 * rejected build is not reviewable at all, so accepting cannot mask it; the build stays failed
 * until a new build arrives. The acceptance reaches the other builds' shots that carry the same
 * change (`decideGroup`).
 */
export async function acceptAllSnapshots(db: Db, input: BuildDecision): Promise<Verdict> {
  return (await decideAll(db, input)).verdict;
}

type BuildDecision = { projectId: string; buildId: string; userId: string };

/** `acceptAllSnapshots`, also naming the builds it moved (PS-23). */
export async function decideAll(db: Db, input: BuildDecision): Promise<Decided> {
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
  const moved = await decideGroup(db, input.projectId, group, decision);
  await refreshBuilds(db, moved);
  return { verdict: await refreshBuildStatus(db, buildId), buildIds: [buildId, ...moved] };
}
