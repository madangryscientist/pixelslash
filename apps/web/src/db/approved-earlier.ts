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
  /**
   * The default branch's image for this key is not the one the approval was measured against:
   * this shot's main baseline and the approving shot's both exist and their image hashes differ
   * (a re-capture of the same pixels does not count). False when either is unknown, since the
   * page never claims a change it did not measure.
   */
  mainChangedSince: boolean;
};

type Build = Pick<typeof builds.$inferSelect, "id" | "projectId" | "branch">;

/** How many builds back the chain is followed; a branch longer than this reads as plain "no change". */
const MAX_HOPS = 50;

/** Baseline shot id → the shots of this build whose approval waits on it. */
export type Waiting = Map<string, string[]>;

export const wait = (waiting: Waiting, baselineId: string, ids: string[]) =>
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
        mainBaselineKey: snapshots.mainBaselineKey,
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

export type Link = Awaited<ReturnType<typeof readLinks>>[number];

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

/** The build that wrote an image, from its key `builds/<buildId>/…`; null for any other shape. */
const ownerOf = (imageKey: string) => /^builds\/([^/]+)\//.exec(imageKey)?.[1] ?? null;

/**
 * The image hash behind each stored image key. A key is per upload, so main re-captured with the
 * same pixels has a new key: only a differing hash means main changed. The read goes by the
 * writing build (indexed), so it never scans the table. A key with no known owner or hash (a row
 * older than the hash column) is left out, and its shot reads as not changed.
 */
async function pixelsOf(db: Db, keys: string[]): Promise<Map<string, string>> {
  const wanted = new Set(keys);
  const owners = [...new Set(keys.flatMap((key) => ownerOf(key) ?? []))];
  // Each statement binds the owning builds and nothing else.
  const rows = await inChunks(owners, 0, (part) =>
    db
      .select({ imageKey: snapshots.imageKey, imageSha256: snapshots.imageSha256 })
      .from(snapshots)
      .where(inArray(snapshots.buildId, part)),
  );
  const out = new Map<string, string>();
  for (const row of rows)
    if (row.imageSha256 && wanted.has(row.imageKey)) out.set(row.imageKey, row.imageSha256);
  return out;
}

/**
 * The unchanged shots of this build, waiting on the shot each was compared against, and the
 * default branch image each was measured against (null when it was not).
 */
async function firstHop(db: Db, buildId: string) {
  const rows = await db
    .select({
      id: snapshots.id,
      baselineSnapshotId: snapshots.baselineSnapshotId,
      mainBaselineKey: snapshots.mainBaselineKey,
    })
    .from(snapshots)
    .where(and(eq(snapshots.buildId, buildId), eq(snapshots.diffStatus, "unchanged")));
  const waiting: Waiting = new Map();
  const mainKeys = new Map<string, string | null>();
  for (const row of rows) {
    mainKeys.set(row.id, row.mainBaselineKey);
    if (row.baselineSnapshotId) wait(waiting, row.baselineSnapshotId, [row.id]);
  }
  return { waiting, mainKeys };
}

/** What ends a walk back through a branch's baselines, and what lets it go on. */
export type ChainRule = {
  /** The link decides the shots waiting on it. */
  settles: (link: Link) => boolean;
  /** The link is the same pixels as its own baseline, so the shots wait on that one instead. */
  passes: (link: Link) => boolean;
  /** Told which shots a settling link decided. */
  settle: (link: Link, ids: string[]) => void;
};

/**
 * Walks each waiting shot back through the same branch's earlier shots, up to `MAX_HOPS` builds:
 * a link that `settles` ends the walk for the shots on it (the rule's `settle` is told), one that `passes`
 * hands them to its own baseline, any other ends it with nothing.
 */
export async function walkChain(db: Db, build: Build, start: Waiting, rule: ChainRule) {
  let waiting = start;
  for (let n = 0; n < MAX_HOPS && waiting.size > 0; n++) {
    const next: Waiting = new Map();
    for (const link of await readLinks(db, build, [...waiting.keys()])) {
      const ids = waiting.get(link.id) ?? [];
      if (rule.settles(link)) rule.settle(link, ids);
      else if (rule.passes(link) && link.baselineSnapshotId)
        wait(next, link.baselineSnapshotId, ids);
    }
    waiting = next;
  }
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
  const { waiting, mainKeys } = await firstHop(db, build.id);
  const settled: Array<{ id: string; link: Link }> = [];
  const settle = (link: Link, ids: string[]) => {
    for (const id of ids) settled.push({ id, link });
  };
  const rule: ChainRule = {
    settles: approves,
    passes: (link) => link.diffStatus === "unchanged",
    settle,
  };
  await walkChain(db, build, waiting, rule);
  // Shots whose main image key differs from the approving shot's: their pixels are compared.
  const mainKeysOf = ({ id, link }: (typeof settled)[number]) => ({
    current: mainKeys.get(id) ?? null,
    approved: link.mainBaselineKey,
  });
  const keys = settled.flatMap((entry) => {
    const { current, approved } = mainKeysOf(entry);
    return current && approved && current !== approved ? [current, approved] : [];
  });
  const pixels = keys.length > 0 ? await pixelsOf(db, keys) : new Map<string, string>();
  for (const entry of settled) {
    const { id: snapshotId, buildId, commitSha, reviewedBy, reviewedAt } = entry.link;
    const { current, approved } = mainKeysOf(entry);
    const was = pixels.get(approved ?? "");
    const is = pixels.get(current ?? "");
    const mainChangedSince = was !== undefined && is !== undefined && was !== is;
    found.set(entry.id, {
      snapshotId,
      buildId,
      commitSha,
      reviewedBy,
      reviewedAt,
      defaultBranch,
      mainChangedSince,
    });
  }
  return found;
}
