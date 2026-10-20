import { and, eq } from "drizzle-orm";
import { type Db, NotFoundError } from "./db";
import { builds, snapshots } from "./schema";

/**
 * Build status after the diff (ob 1470, review model 1422). A changed shot blocks until it is
 * accepted or rejected; new and removed shots never block; any rejection fails the build until a
 * new build arrives. `passed` therefore means "nothing left to decide", not "no differences".
 */
export type Verdict = "changes" | "passed" | "failed";

type Decidable = {
  diffStatus: "changed" | "new" | "removed" | "unchanged" | null;
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

async function reviewableBuild(db: Db, projectId: string, snapshotId: string): Promise<string> {
  const [row] = await db
    .select({ buildId: snapshots.buildId, status: builds.status })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(and(eq(snapshots.id, snapshotId), eq(builds.projectId, projectId)));
  if (!row) throw new NotFoundError("snapshot");
  if (row.status !== "changes" && row.status !== "passed") throw new NotReviewableError(row.status);
  return row.buildId;
}

export async function reviewSnapshot(
  db: Db,
  input: {
    projectId: string;
    snapshotId: string;
    state: "accepted" | "rejected";
    userId: string;
  },
): Promise<Verdict> {
  const buildId = await reviewableBuild(db, input.projectId, input.snapshotId);
  await db
    .update(snapshots)
    .set({ reviewState: input.state, reviewedBy: input.userId, reviewedAt: new Date() })
    .where(eq(snapshots.id, input.snapshotId));
  return refreshBuildStatus(db, buildId);
}
