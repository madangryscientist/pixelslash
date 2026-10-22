import { and, eq, inArray, lt, or } from "drizzle-orm";
import type { Db } from "./db";
import { heldShot, notSkippedFlaky } from "./markers";
import { builds, snapshots } from "./schema";

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
        notSkippedFlaky(),
      ),
    )
    .limit(1);
  return !earlier;
}
