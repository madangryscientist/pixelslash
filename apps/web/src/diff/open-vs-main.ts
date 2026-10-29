import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type Waiting, wait, walkChain } from "#/db/approved-earlier";
import type { Build } from "#/db/builds";
import { chunk, inChunks } from "#/db/chunks";
import type { Db } from "#/db/db";
import { snapshots } from "#/db/schema";

type Open = { id: string; baselineSnapshotId: string };

/**
 * The shots whose difference from main someone already accepted. The walk goes back through the
 * branch's earlier shots that were themselves unchanged against theirs (the same pixels, so one
 * decision covers them all) and stops at the first that is accepted. A rejected or changed shot, or
 * one on another branch, ends it undecided. Accepting a carried change accepts its root, which is
 * unchanged against its own baseline, so this reads `reviewState` and not `diffStatus` (the
 * `approvedEarlier` label wants a change).
 */
async function decidedOf(db: Db, build: Build, open: Open[]): Promise<Set<string>> {
  const decided = new Set<string>();
  const waiting: Waiting = new Map();
  for (const shot of open) wait(waiting, shot.baselineSnapshotId, [shot.id]);
  await walkChain(db, build, waiting, {
    settles: (link) => link.reviewState === "accepted",
    passes: (link) => link.reviewState === "pending" && link.diffStatus === "unchanged",
    settle: (_link, ids) => {
      for (const id of ids) decided.add(id);
    },
  });
  return decided;
}

/** The root each baseline shot's group is decided on: what it carries, or itself (`carry` in the baseline pick). */
async function rootsOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const found = await inChunks(ids, 0, (part) =>
    db
      .select({ id: snapshots.id, carriedFrom: snapshots.carriedFrom })
      .from(snapshots)
      .where(inArray(snapshots.id, part)),
  );
  return new Map(found.map((row) => [row.id, row.carriedFrom ?? row.id]));
}

/**
 * A branch shot that is unchanged against the branch's previous shot, still differs from main and
 * was never accepted along the way, holds a change that is open (PS-284). Rule 1 compares it with
 * the previous shot only, so an open change the previous build did not carry (a build measured
 * before PS-282 against an unmeasured baseline, one that ended `passed` on it) would vanish from
 * the verdict. It is carried exactly as an identical shot carries a pending one (ob 1712): from
 * the root of its baseline shot's group, so a reviewer decides once for the whole chain. The pixel diff and the
 * baseline picks are untouched; this reads the result against main (ob 1723) after it is stored.
 */
export async function carryOpenFromMain(db: Db, build: Build): Promise<void> {
  const rows = await db
    .select({ id: snapshots.id, baselineSnapshotId: snapshots.baselineSnapshotId })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.buildId, build.id),
        eq(snapshots.diffStatus, "unchanged"),
        eq(snapshots.reviewState, "pending"),
        isNull(snapshots.carriedFrom),
        isNotNull(snapshots.baselineSnapshotId),
        inArray(snapshots.mainDiffStatus, ["changed", "new"]),
      ),
    );
  const open = rows.flatMap(({ id, baselineSnapshotId }) =>
    baselineSnapshotId === null ? [] : [{ id, baselineSnapshotId }],
  );
  if (open.length === 0) return;
  const decided = await decidedOf(db, build, open);
  const undecided = open.filter((shot) => !decided.has(shot.id));
  const roots = await rootsOf(
    db,
    undecided.map((shot) => shot.baselineSnapshotId),
  );
  const byRoot = new Map<string, string[]>();
  for (const shot of undecided) {
    const root = roots.get(shot.baselineSnapshotId);
    if (root !== undefined) byRoot.set(root, [...(byRoot.get(root) ?? []), shot.id]);
  }
  for (const [root, ids] of byRoot)
    for (const part of chunk(ids, 1))
      await db.update(snapshots).set({ carriedFrom: root }).where(inArray(snapshots.id, part));
}
