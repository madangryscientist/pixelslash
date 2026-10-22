import { and, eq, inArray, isNull } from "drizzle-orm";
import { selectBaselines, snapshotKeyOf } from "#/db/baselines";
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
    .where(
      inArray(
        snapshots.id,
        targets.map((t) => t.id),
      ),
    );
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
  const after = await db
    .select()
    .from(snapshots)
    .where(
      inArray(
        snapshots.id,
        before.map((t) => t.id),
      ),
    );
  const prior = new Map(before.map((row) => [row.id, resultOf(row)]));
  const moved = after.filter((row) => prior.get(row.id) !== resultOf(row)).map((row) => row.id);
  if (moved.length === 0) return;
  await db
    .update(snapshots)
    .set({ reviewState: "pending", reviewedBy: null, reviewedAt: null })
    .where(inArray(snapshots.id, moved));
  if (build.branch !== project.defaultBranch) return;
  await db
    .update(snapshots)
    .set({ reviewState: "accepted", reviewedAt: new Date() })
    .where(and(inArray(snapshots.id, moved), isNull(snapshots.flakeId)));
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
  const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
  const target = targetOf(rows, snapshotId);
  if (!(await claimForRerun(deps.db, build)))
    throw new RerunError(`build is ${build.status}: a diff run holds it or it has no verdict yet`);
  try {
    await clearResults(deps.db, [target]);
    const held = rows.filter((row) => !isMarker(row));
    const baselines = await selectBaselines(deps.db, build, new Set(held.map(snapshotKeyOf)));
    const cleared = { ...target, diffStatus: null, rebaselineNeeded: false };
    await measureAll(deps, { build, project, only: new Set([target.id]) }, [cleared], baselines);
    await settleReviews(deps.db, { build, project }, [target]);
    return { status: await refreshBuildStatus(deps.db, build.id), error: null, unmeasured: 0 };
  } catch (e) {
    // The review was on a result the shot no longer has: it is decided again once it is measured.
    await deps.db
      .update(snapshots)
      .set({ reviewState: "pending", reviewedBy: null, reviewedAt: null })
      .where(eq(snapshots.id, target.id));
    await markErrored(deps.db, build, e);
    return { status: "errored", error: e instanceof Error ? e.message : String(e), unmeasured: 0 };
  }
}
