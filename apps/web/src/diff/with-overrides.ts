import { eq } from "drizzle-orm";
import type { Db } from "#/db/db";
import { loadOverrides, optionsKey } from "#/db/overrides";
import { snapshots } from "#/db/schema";
import type { SnapshotRow } from "./compare";

/** The options a stored result was measured with: the resolved set, or as uploaded before ob 1495. */
const measuredWith = (shot: SnapshotRow) => shot.resolvedDiff?.options ?? shot.diffOptions;

const UNMEASURED: Partial<SnapshotRow> = {
  diffStatus: null,
  rebaselineNeeded: false,
  mainBaselineKey: null,
  mainDiffStatus: null,
};
/** A review given on a result the new options replace is decided again (`settleReviews` in a re-diff). */
const UNREVIEWED: Partial<SnapshotRow> = {
  reviewState: "pending",
  reviewedBy: null,
  reviewedAt: null,
};
const stood = (shot: SnapshotRow) => shot.diffStatus !== null || shot.rebaselineNeeded;

/**
 * Resolve each shot's options with the project's review-UI overrides (ob 1495) and store them with
 * it, so the comparer measures with them and the page can say where each value came from. A shot
 * whose options moved since it was measured (an override set or cleared) loses its result, against
 * its baseline and against main, so it is measured again with the new ones.
 */
export async function withOverrides(
  db: Db,
  projectId: string,
  rows: SnapshotRow[],
): Promise<SnapshotRow[]> {
  const overrides = await loadOverrides(db, projectId);
  const out: SnapshotRow[] = [];
  for (const shot of rows) {
    const resolvedDiff = overrides.resolve(shot);
    const moved = optionsKey(resolvedDiff.options) !== optionsKey(measuredWith(shot));
    const cleared = moved ? { ...UNMEASURED, ...(stood(shot) ? UNREVIEWED : {}) } : {};
    if (moved || JSON.stringify(resolvedDiff) !== JSON.stringify(shot.resolvedDiff))
      await db
        .update(snapshots)
        .set({ resolvedDiff, ...cleared })
        .where(eq(snapshots.id, shot.id));
    out.push({ ...shot, resolvedDiff, ...cleared });
  }
  return out;
}
