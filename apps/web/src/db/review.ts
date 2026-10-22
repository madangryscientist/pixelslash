import { and, count, desc, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import {
  SNAPSHOT_GROUPS,
  type SnapshotGroup,
  awaitsDecision,
  groupOf,
} from "#/lib/snapshot-groups";
import { heldShot } from "./markers";
import { decideGroup, groupOfShot, groupsOfBuild } from "./carried";
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
      carriedFrom: snapshots.carriedFrom,
      createdAt: snapshots.createdAt,
    })
    .from(snapshots)
    .leftJoin(users, eq(users.id, snapshots.reviewedBy))
    .where(eq(snapshots.buildId, buildId));
  const roots = new Map(
    (
      await db
        .select({ id: snapshots.id, buildId: snapshots.buildId })
        .from(snapshots)
        .where(
          inArray(
            snapshots.id,
            db
              .select({ id: snapshots.carriedFrom })
              .from(snapshots)
              .where(and(eq(snapshots.buildId, buildId), isNotNull(snapshots.carriedFrom))),
          ),
        )
    ).map((root) => [root.id, root.buildId]),
  );
  const ordered = rows
    .map(({ reviewer, ...row }) => ({
      ...row,
      reviewedBy: reviewer,
      carriedFromBuild: (row.carriedFrom && roots.get(row.carriedFrom)) ?? null,
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
  return { build, snapshots: ordered };
}

/**
 * True when no earlier build of the project holds a shot that baseline selection could pick (ob 1718):
 * the same predicate as `queryCandidates` in `baselines.ts`, without the merge-base reach. A build
 * that errored or was rejected (`failed`) is not a candidate, so the build after it sets the
 * baseline. Read, not stored: how a first build is stored and diffed is unchanged.
 */
export async function isFirstBuild(db: Db, build: typeof builds.$inferSelect): Promise<boolean> {
  const [earlier] = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(
      and(
        eq(builds.projectId, build.projectId),
        or(
          lt(builds.createdAt, build.createdAt),
          and(eq(builds.createdAt, build.createdAt), lt(builds.id, build.id)),
        ),
        inArray(builds.status, ["changes", "passed"]),
        or(
          eq(builds.status, "passed"),
          eq(snapshots.reviewState, "accepted"),
          eq(builds.branch, build.branch),
        ),
        heldShot(),
      ),
    )
    .limit(1);
  return !earlier;
}

export type BuildCounts = Record<SnapshotGroup, number> & {
  pending: number;
  /** Shots that wait for a decision (`awaitsDecision`): what the build page calls "to review". */
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
      carried: isNotNull(snapshots.carriedFrom),
      n: count(),
    })
    .from(snapshots)
    .where(inArray(snapshots.buildId, buildIds))
    .groupBy(
      snapshots.buildId,
      snapshots.diffStatus,
      snapshots.rebaselineNeeded,
      snapshots.reviewState,
      isNotNull(snapshots.carriedFrom),
    );
  for (const stat of stats) {
    const held = counts.get(stat.buildId) ?? emptyCounts();
    held[groupOf(stat)] += stat.n;
    if (stat.reviewState === "pending") held.pending += stat.n;
    if (awaitsDecision({ ...stat, carriedFrom: stat.carried ? "" : null })) held.toReview += stat.n;
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
    .where(and(eq(snapshots.buildId, buildId), ne(snapshots.reviewState, "accepted")));
  const group = groupsOfBuild(db, buildId);
  await refreshBuilds(db, await decideGroup(db, input.projectId, group, decision));
  return refreshBuildStatus(db, buildId);
}
