import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { SNAPSHOT_GROUPS, type SnapshotGroup, groupOf } from "#/lib/snapshot-groups";
import { type Db, NotFoundError } from "./db";
import {
  type DiffOptions,
  type DiffResult,
  type DiffStatus,
  type IgnoreRect,
  type ReviewState,
  builds,
  snapshots,
  users,
} from "./schema";

/**
 * Build status after the diff (ob 1470, review model 1422). A changed shot blocks until it is
 * accepted or rejected; new and removed shots never block; any rejection fails the build until a
 * new build arrives. `passed` therefore means "nothing left to decide", not "no differences".
 */
export type Verdict = "changes" | "passed" | "failed";

type Decidable = {
  diffStatus: DiffStatus | null;
  reviewState: string;
};

export function verdictOf(rows: Decidable[]): Verdict {
  if (rows.some((row) => row.reviewState === "rejected")) return "failed";
  if (rows.some((row) => row.diffStatus === "changed" && row.reviewState === "pending"))
    return "changes";
  return "passed";
}

export async function refreshBuildStatus(db: Db, buildId: string): Promise<Verdict> {
  const rows = await db
    .select({ diffStatus: snapshots.diffStatus, reviewState: snapshots.reviewState })
    .from(snapshots)
    .where(eq(snapshots.buildId, buildId));
  const status = verdictOf(rows);
  await db.update(builds).set({ status }).where(eq(builds.id, buildId));
  return status;
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
  ignore: IgnoreRect[];
  imageKey: string;
  baselineKey: string | null;
  diffKey: string | null;
  diffResult: DiffResult | null;
  rebaselineNeeded: boolean;
  createdAt: Date;
};

export type BuildView = {
  build: typeof builds.$inferSelect;
  /** Ordered as the review walks them: changed, new, removed, unchanged, re-baseline, unmeasured. */
  snapshots: SnapshotView[];
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
      ignore: snapshots.ignore,
      imageKey: snapshots.imageKey,
      baselineKey: snapshots.baselineKey,
      diffKey: snapshots.diffKey,
      diffResult: snapshots.diffResult,
      rebaselineNeeded: snapshots.rebaselineNeeded,
      createdAt: snapshots.createdAt,
    })
    .from(snapshots)
    .leftJoin(users, eq(users.id, snapshots.reviewedBy))
    .where(eq(snapshots.buildId, buildId));
  const ordered = rows
    .map(({ reviewer, ...row }) => ({ ...row, reviewedBy: reviewer }))
    .toSorted(
      (a, b) =>
        SNAPSHOT_GROUPS.indexOf(groupOf(a)) - SNAPSHOT_GROUPS.indexOf(groupOf(b)) ||
        a.name.localeCompare(b.name) ||
        a.platform.localeCompare(b.platform) ||
        a.browser.localeCompare(b.browser) ||
        a.viewport.localeCompare(b.viewport) ||
        a.theme.localeCompare(b.theme),
    );
  return { build, snapshots: ordered };
}

export type BuildCounts = Record<SnapshotGroup, number> & {
  pending: number;
  /** Changed shots nobody has decided yet: what the build page calls "to review". */
  toReview: number;
};

export type BuildSummary = {
  id: string;
  branch: string;
  commitSha: string;
  prNumber: number | null;
  status: (typeof builds.$inferSelect)["status"];
  error: string | null;
  createdAt: Date;
  counts: BuildCounts;
};

export const emptyCounts = (): BuildCounts => ({
  changed: 0,
  new: 0,
  removed: 0,
  unchanged: 0,
  rebaseline: 0,
  unmeasured: 0,
  pending: 0,
  toReview: 0,
});

/** The per-group counts of each build's shots, in one grouped read. A build with no shots is absent. */
export async function countBuilds(db: Db, buildIds: string[]): Promise<Map<string, BuildCounts>> {
  const counts = new Map<string, BuildCounts>();
  if (buildIds.length === 0) return counts;
  const stats = await db
    .select({
      buildId: snapshots.buildId,
      diffStatus: snapshots.diffStatus,
      rebaselineNeeded: snapshots.rebaselineNeeded,
      reviewState: snapshots.reviewState,
      n: count(),
    })
    .from(snapshots)
    .where(inArray(snapshots.buildId, buildIds))
    .groupBy(
      snapshots.buildId,
      snapshots.diffStatus,
      snapshots.rebaselineNeeded,
      snapshots.reviewState,
    );
  for (const stat of stats) {
    const held = counts.get(stat.buildId) ?? emptyCounts();
    held[groupOf(stat)] += stat.n;
    if (stat.reviewState === "pending") held.pending += stat.n;
    if (stat.diffStatus === "changed" && stat.reviewState === "pending") held.toReview += stat.n;
    counts.set(stat.buildId, held);
  }
  return counts;
}

/** Every build of a project, newest first, with the counts the project page prints. */
export async function listBuilds(db: Db, projectId: string): Promise<BuildSummary[]> {
  const rows = await db
    .select({
      id: builds.id,
      branch: builds.branch,
      commitSha: builds.commitSha,
      prNumber: builds.prNumber,
      status: builds.status,
      error: builds.error,
      createdAt: builds.createdAt,
    })
    .from(builds)
    .where(eq(builds.projectId, projectId))
    .orderBy(desc(builds.createdAt), desc(builds.id));
  if (rows.length === 0) return [];
  const counts = await countBuilds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, counts: counts.get(row.id) ?? emptyCounts() }));
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

async function snapshotBuildId(db: Db, projectId: string, snapshotId: string): Promise<string> {
  const [row] = await db
    .select({ buildId: snapshots.buildId, status: builds.status })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.id, snapshotId), eq(builds.projectId, projectId)));
  if (!row) throw new NotFoundError("snapshot");
  if (row.status !== "changes" && row.status !== "passed") throw new NotReviewableError(row.status);
  return row.buildId;
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
  const buildId = await snapshotBuildId(db, input.projectId, input.snapshotId);
  await db
    .update(snapshots)
    .set({ reviewState: input.state, reviewedBy: input.userId, reviewedAt: new Date() })
    .where(eq(snapshots.id, input.snapshotId));
  return refreshBuildStatus(db, buildId);
}

/**
 * Accept every shot of the build, recording who and when. A rejection is never undone — a
 * rejected build is not reviewable at all, so accepting cannot mask it; the build stays failed
 * until a new build arrives.
 */
export async function acceptAllSnapshots(
  db: Db,
  input: { projectId: string; buildId: string; userId: string },
): Promise<Verdict> {
  const buildId = await reviewableBuildId(db, input.projectId, input.buildId);
  await db
    .update(snapshots)
    .set({ reviewState: "accepted", reviewedBy: input.userId, reviewedAt: new Date() })
    .where(and(eq(snapshots.buildId, buildId), ne(snapshots.reviewState, "accepted")));
  return refreshBuildStatus(db, buildId);
}
