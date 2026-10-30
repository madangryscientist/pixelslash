import { count, inArray, isNotNull } from "drizzle-orm";
import {
  type SnapshotGroup,
  awaitsDecision,
  groupOf,
  reviewGroupOf,
  skippedFlaky,
} from "#/lib/snapshot-groups";
import { inChunks } from "./chunks";
import type { Db } from "./db";
import { snapshots } from "./schema";

export type BuildCounts = Record<SnapshotGroup, number> & {
  pending: number;
  accepted: number;
  rejected: number;
  /** Shots that wait for a decision (`awaitsDecision`): what the build page calls "to review". */
  toReview: number;
  /** Flaky shots their config skips (`skippedFlaky`, ob 1724): counted on a line of their own. */
  skippedFlaky: number;
  /**
   * Shots carried from main (PS-285): `unchanged` against the previous build, yet counted in
   * `changed` or `new` above because that is where a reviewer finds them. The API subtracts them.
   */
  carriedFromMain: { changed: number; new: number };
};

export const emptyCounts = (): BuildCounts => ({
  changed: 0,
  new: 0,
  removed: 0,
  unchanged: 0,
  rebaseline: 0,
  unmeasured: 0,
  pending: 0,
  accepted: 0,
  rejected: 0,
  toReview: 0,
  skippedFlaky: 0,
  carriedFromMain: { changed: 0, new: 0 },
});

/** The grouped columns of `countBuilds`: each is selected and grouped by. */
const statColumns = {
  buildId: snapshots.buildId,
  diffStatus: snapshots.diffStatus,
  mainDiffStatus: snapshots.mainDiffStatus,
  rebaselineNeeded: snapshots.rebaselineNeeded,
  reviewState: snapshots.reviewState,
  carried: isNotNull(snapshots.carriedFrom),
  flaky: isNotNull(snapshots.flakeId),
  flakyPolicy: snapshots.flakyPolicy,
};

/**
 * The per-group counts of each build's shots, in one grouped read per part of the ids (a project
 * page counts every build of the project). A build with no shots is absent.
 */
export async function countBuilds(db: Db, buildIds: string[]): Promise<Map<string, BuildCounts>> {
  const counts = new Map<string, BuildCounts>();
  const stats = await inChunks(buildIds, 0, (part) =>
    db
      .select({ ...statColumns, n: count() })
      .from(snapshots)
      .where(inArray(snapshots.buildId, part))
      .groupBy(...Object.values(statColumns)),
  );
  for (const stat of stats) {
    const held = counts.get(stat.buildId) ?? emptyCounts();
    const row = { ...stat, carriedFrom: stat.carried ? "" : null, flakeId: stat.flaky ? "" : null };
    const group = reviewGroupOf(row);
    held[group] += stat.n;
    if (group !== groupOf(stat) && (group === "changed" || group === "new"))
      held.carriedFromMain[group] += stat.n;
    held[stat.reviewState] += stat.n;
    if (awaitsDecision(row)) held.toReview += stat.n;
    if (skippedFlaky(row)) held.skippedFlaky += stat.n;
    counts.set(stat.buildId, held);
  }
  return counts;
}
