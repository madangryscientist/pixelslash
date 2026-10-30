import { and, count, desc, eq } from "drizzle-orm";
import { type BranchShot, branchShot } from "#/lib/branch-review";
import { type Db, NotFoundError } from "./db";
import { isMarker } from "./markers";
import { type BuildView, buildView } from "./review";
import { builds } from "./schema";

/**
 * The branch page (ob 1723): a branch's newest build, read two ways. `head` is that build as the
 * build page shows it (since the branch's previous build); `againstMain` is the same shots read
 * against main from what the diff stored. Read only: nothing is measured here.
 */
export type BranchView = BuildView & {
  /** The head build's shots against main, in build order; removed markers are not shots of it. */
  againstMain: BranchShot[];
  /** How many builds the branch has. */
  buildCount: number;
  /** The branch's build before the head, which "since last build" is measured from; null on its first. */
  previous: { id: string; commitSha: string } | null;
};

export async function branchView(db: Db, projectId: string, branch: string): Promise<BranchView> {
  const recent = await db
    .select({ id: builds.id, commitSha: builds.commitSha })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.branch, branch)))
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(2);
  const [head, previous] = recent;
  if (!head) throw new NotFoundError("branch");
  const [counted] = await db
    .select({ n: count() })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.branch, branch)));
  const view = await buildView(db, projectId, head.id);
  return {
    ...view,
    againstMain: view.snapshots
      .filter((shot) => !isMarker(shot))
      .map((shot) => branchShot(shot, view.build)),
    buildCount: counted?.n ?? 1,
    previous: previous ?? null,
  };
}
