import { and, eq, inArray, isNull } from "drizzle-orm";
import { selectBaselines, snapshotKeyOf } from "#/db/baselines";
import { chunk, inChunks } from "#/db/chunks";
import type { Db } from "#/db/db";
import type { Build } from "#/db/builds";
import { isMarker } from "#/db/markers";
import { refreshBuildStatus } from "#/db/review";
import { snapshots } from "#/db/schema";
import { NoRecoveryError, claimForRerun } from "./claim";
import type { SnapshotRow } from "./compare";
import { type ProjectOfBuild, markErrored, projectOf } from "./build-writes";
import { type ProcessDeps, type ProcessResult, measureAll, processBuild } from "./process";

/**
 * Partial re-runs (ob 1738): measure again only the shots of a build that errored, or one shot
 * a reviewer picked, without a new CI run and without capturing anything (the server has no
 * browser; it re-diffs the PNGs it holds). Server-diff projects only: a CI project's results are
 * the CI job's, so it is refused, like ob 1545's recovery.
 */

/** A re-run that cannot start: the build is held by a run, or there is nothing to re-run. */
export class RerunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerunError";
  }
}

/** The picked shot, which must be one of the build's own shots with an image. */
function targetOf(rows: SnapshotRow[], snapshotId: string): SnapshotRow {
  const row = rows.find((r) => r.id === snapshotId);
  if (!row) throw new RerunError(`shot ${snapshotId} is not in this build`);
  if (isMarker(row)) throw new RerunError(`${row.name} was removed: there is no shot to re-diff`);
  return row;
}

/** The result a review was given on: when a re-run measures the same, the review still stands. */
const resultOf = (row: SnapshotRow) =>
  JSON.stringify([
    row.diffStatus,
    row.diffResult,
    row.rebaselineNeeded,
    row.baselineKey,
    row.carriedFrom,
  ]);

/**
 * Forget the targets' results, so the run measures them (`stands` is false for a shot with no
 * status). The main fields are cleared too, so the shot is measured against main again; the
 * overlay keys stay, so the run can drop an overlay it no longer writes.
 */
async function clearResults(db: Db, targets: SnapshotRow[]): Promise<void> {
  // The six cleared fields are bound beside the ids.
  for (const part of chunk(
    targets.map((t) => t.id),
    6,
  ))
    await db
      .update(snapshots)
      .set({
        diffStatus: null,
        diffResult: null,
        rebaselineNeeded: false,
        diffError: null,
        mainBaselineKey: null,
        mainDiffStatus: null,
      })
      .where(inArray(snapshots.id, part));
}

/** Send a shot's review back to pending: three fields bound beside the ids. */
async function reopenReviews(db: Db, ids: string[]): Promise<void> {
  for (const part of chunk(ids, 3))
    await db
      .update(snapshots)
      .set({ reviewState: "pending", reviewedBy: null, reviewedAt: null })
      .where(inArray(snapshots.id, part));
}

/**
 * The review rule for a re-diffed shot: one measured the same as before keeps its review; one whose
 * result moved goes back to pending, since the decision was on another result. On the default branch
 * a moved one is accepted again, as a fresh build's would be (ob 1559), unless it is flaky (ob 1724).
 */
async function settleReviews(
  db: Db,
  { build, project }: { build: Build; project: ProjectOfBuild },
  before: SnapshotRow[],
): Promise<void> {
  const after = await inChunks(
    before.map((t) => t.id),
    0,
    (part) => db.select().from(snapshots).where(inArray(snapshots.id, part)),
  );
  const prior = new Map(before.map((row) => [row.id, resultOf(row)]));
  const moved = after.filter((row) => prior.get(row.id) !== resultOf(row)).map((row) => row.id);
  if (moved.length === 0) return;
  await reopenReviews(db, moved);
  if (build.branch !== project.defaultBranch) return;
  const reviewedAt = new Date();
  for (const part of chunk(moved, 2))
    await db
      .update(snapshots)
      .set({ reviewState: "accepted", reviewedAt })
      .where(and(inArray(snapshots.id, part), isNull(snapshots.flakeId)));
}

/**
 * Re-diff the shots of a build that errored (`snapshotId` null), or one shot a reviewer picked on a
 * build with a verdict, and give the build its verdict again. Errored shots are what a finalise
 * sent again measures already (ob 1545), so that is `processBuild`; a picked shot is measured on
 * its own, and the rest of the build keeps what it has, reviews included.
 */
export async function rerunShots(
  deps: ProcessDeps,
  build: Build,
  snapshotId: string | null,
): Promise<ProcessResult> {
  const project = await projectOf(deps.db, build);
  if (project.diffLocation === "ci") throw new NoRecoveryError();
  if (snapshotId === null) {
    if (build.status !== "errored")
      throw new RerunError(`build is ${build.status}: nothing errored`);
    return processBuild(deps, build);
  }
  return rediffShots(deps, build, [snapshotId]);
}

/**
 * Re-diff the picked shots of a build with a verdict, and give it its verdict again: one shot a
 * reviewer picked, or every shot of the build a review-UI override applies to (ob 1495). The rest
 * of the build keeps what it has, reviews included.
 */
export async function rediffShots(
  deps: ProcessDeps,
  build: Build,
  snapshotIds: string[],
): Promise<ProcessResult> {
  const project = await projectOf(deps.db, build);
  if (project.diffLocation === "ci") throw new NoRecoveryError();
  const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
  const targets = snapshotIds.map((id) => targetOf(rows, id));
  if (targets.length === 0) throw new RerunError("no shot to re-diff");
  if (!(await claimForRerun(deps.db, build)))
    throw new RerunError(`build is ${build.status}: a diff run holds it or it has no verdict yet`);
  const ids = targets.map((t) => t.id);
  try {
    await clearResults(deps.db, targets);
    const held = rows.filter((row) => !isMarker(row));
    const baselines = await selectBaselines(deps.db, build, new Set(held.map(snapshotKeyOf)));
    const cleared = targets.map((t) => ({ ...t, diffStatus: null, rebaselineNeeded: false }));
    await measureAll(deps, { build, project, only: new Set(ids) }, cleared, baselines);
    await settleReviews(deps.db, { build, project }, targets);
    return { status: await refreshBuildStatus(deps.db, build.id), error: null, unmeasured: 0 };
  } catch (e) {
    // The review was on a result the shot no longer has: it is decided again once it is measured.
    await reopenReviews(deps.db, ids);
    await markErrored(deps.db, build, e);
    return { status: "errored", error: e instanceof Error ? e.message : String(e), unmeasured: 0 };
  }
}
