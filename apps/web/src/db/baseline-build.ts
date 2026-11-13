import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { builds, snapshots } from "./schema";

/** The build whose shot a snapshot was compared with first: what the viewer's left pane shows. */
export type BaselineBuild = {
  /** The baseline shot, so the viewer can link straight to it. */
  snapshotId: string;
  buildId: string;
  branch: string;
  commitSha: string;
  /** On the project's default branch, so the pane is main's baseline and not an earlier branch build. */
  isDefaultBranch: boolean;
};

/**
 * The build behind a shot's baseline (`baseline_snapshot_id`), scoped to the project. Null when the
 * shot had no baseline, when it predates the column, or when the baseline's build is gone. The id
 * itself is not exposed in `/api/v1`: only the viewer needs to say what it is looking at.
 */
export async function baselineBuildOf(
  db: Db,
  input: { projectId: string; snapshotId: string; defaultBranch: string },
): Promise<BaselineBuild | null> {
  const [shot] = await db
    .select({ baselineSnapshotId: snapshots.baselineSnapshotId })
    .from(snapshots)
    .where(eq(snapshots.id, input.snapshotId));
  if (!shot?.baselineSnapshotId) return null;
  const [base] = await db
    .select({
      snapshotId: snapshots.id,
      buildId: builds.id,
      branch: builds.branch,
      commitSha: builds.commitSha,
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.id, shot.baselineSnapshotId), eq(builds.projectId, input.projectId)));
  if (!base) return null;
  return { ...base, isDefaultBranch: base.branch === input.defaultBranch };
}
