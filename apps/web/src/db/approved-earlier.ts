import { and, eq, inArray, ne } from "drizzle-orm";
import { inChunks } from "./chunks";
import type { Db } from "./db";
import { builds, projects, snapshots, users } from "./schema";

/**
 * Where an unchanged shot's difference from the default branch was decided (ob 1722). Since 1712 a
 * branch build is compared with the branch's previous shot, so a change accepted there reads "no
 * change" here although the shot still differs from the default branch. This names the shot that
 * was accepted, on which build, by whom: read from the stored baseline chain, never re-diffed.
 */
export type ApprovedEarlier = {
  snapshotId: string;
  buildId: string;
  commitSha: string;
  /** The reviewer's GitHub login; null when the account is gone. */
  reviewedBy: string | null;
  reviewedAt: Date | null;
  /** The project's default branch: what the accepted change was measured against. */
  defaultBranch: string;
};

type Build = Pick<typeof builds.$inferSelect, "id" | "projectId" | "branch">;

/** How many builds back the chain is followed; a branch longer than this reads as plain "no change". */
const MAX_HOPS = 50;

/** Baseline shot id → the shots of this build whose approval waits on it. */
type Waiting = Map<string, string[]>;

const wait = (waiting: Waiting, baselineId: string, ids: string[]) =>
  waiting.set(baselineId, [...(waiting.get(baselineId) ?? []), ...ids]);

/**
 * The baseline shots of one hop, on the same branch and not this build: another branch ends the walk.
 * The ids are sent in parts: beside them the statement binds the project, the branch and the build.
 */
function readLinks(db: Db, build: Build, ids: string[]) {
  return inChunks(ids, 3, (part) =>
    db
      .select({
        id: snapshots.id,
        buildId: snapshots.buildId,
        diffStatus: snapshots.diffStatus,
        reviewState: snapshots.reviewState,
        reviewedAt: snapshots.reviewedAt,
        reviewedBy: users.login,
        baselineSnapshotId: snapshots.baselineSnapshotId,
        commitSha: builds.commitSha,
      })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .leftJoin(users, eq(users.id, snapshots.reviewedBy))
      .where(
        and(
          inArray(snapshots.id, part),
          eq(builds.projectId, build.projectId),
          eq(builds.branch, build.branch),
          ne(builds.id, build.id),
        ),
      ),
  );
}

type Link = Awaited<ReturnType<typeof readLinks>>[number];

/** The shot that measured the change against the default branch, and someone accepted it. */
const approves = (link: Link) =>
  (link.diffStatus === "changed" || link.diffStatus === "new") && link.reviewState === "accepted";

async function defaultBranchOf(db: Db, projectId: string): Promise<string | undefined> {
  const [project] = await db
    .select({ defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId));
  return project?.defaultBranch;
}

/** The unchanged shots of this build, waiting on the shot each was compared against. */
async function firstHop(db: Db, buildId: string): Promise<Waiting> {
  const rows = await db
    .select({ id: snapshots.id, baselineSnapshotId: snapshots.baselineSnapshotId })
    .from(snapshots)
    .where(and(eq(snapshots.buildId, buildId), eq(snapshots.diffStatus, "unchanged")));
  const waiting: Waiting = new Map();
  for (const row of rows)
    if (row.baselineSnapshotId) wait(waiting, row.baselineSnapshotId, [row.id]);
  return waiting;
}

/** One hop back: an accepted change settles the shots waiting on it; an unchanged shot passes them on. */
async function hop(
  db: Db,
  build: Build,
  waiting: Waiting,
  settle: (link: Link, ids: string[]) => void,
) {
  const next: Waiting = new Map();
  for (const link of await readLinks(db, build, [...waiting.keys()])) {
    const ids = waiting.get(link.id) ?? [];
    if (approves(link)) settle(link, ids);
    else if (link.diffStatus === "unchanged" && link.baselineSnapshotId)
      wait(next, link.baselineSnapshotId, ids);
  }
  return next;
}

/**
 * The approval behind each unchanged shot of a branch build. A shot's baseline is walked back through
 * the same branch's earlier shots that were themselves unchanged, to the first that held a change
 * (changed or new) and was accepted. Anything else ends the walk with no label: a baseline on
 * another branch, a pending or rejected change, a row diffed before the baseline was recorded.
 * Nothing at all on the default branch, whose shots are the baseline.
 */
export async function approvedEarlier(db: Db, build: Build): Promise<Map<string, ApprovedEarlier>> {
  const found = new Map<string, ApprovedEarlier>();
  const defaultBranch = await defaultBranchOf(db, build.projectId);
  if (defaultBranch === undefined || build.branch === defaultBranch) return found;
  const settle = (link: Link, ids: string[]) => {
    const { id: snapshotId, buildId, commitSha, reviewedBy, reviewedAt } = link;
    const approval = { snapshotId, buildId, commitSha, reviewedBy, reviewedAt, defaultBranch };
    for (const id of ids) found.set(id, approval);
  };
  let waiting = await firstHop(db, build.id);
  for (let n = 0; n < MAX_HOPS && waiting.size > 0; n++)
    waiting = await hop(db, build, waiting, settle);
  return found;
}
