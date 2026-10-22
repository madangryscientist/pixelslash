import { eq } from "drizzle-orm";
import type { Build } from "#/db/builds";
import { isMarker } from "#/db/markers";
import { type OverrideTarget, saveOverride } from "#/db/overrides";
import { snapshots } from "#/db/schema";
import type { DiffOptions } from "#/db/schema";
import type { SnapshotRow } from "./compare";
import type { ProcessDeps } from "./process";
import { RerunError, rediffShots } from "./rerun";

/**
 * Saving a review-UI override (ob 1495): store it with its audit row, then re-diff the shots of the
 * open build it applies to, so the reviewer sees the verdict it gives at once. Every later build
 * reads it when it is measured. A build with no verdict yet (still processing, or errored) is not
 * re-diffed here: its next run measures with the override.
 */

export type SavedOverride = {
  changed: boolean;
  /** How many of the open build's shots were measured again. */
  rediffed: number;
  status: Build["status"];
  /** Why the open build was not re-diffed, when it was not. */
  note: string | null;
};

const VERDICTS: Build["status"][] = ["changes", "passed", "failed"];

function applies(row: SnapshotRow, target: OverrideTarget): boolean {
  if (row.name !== target.name || isMarker(row)) return false;
  const v = target.variant;
  if (!v) return true;
  return (
    row.platform === v.platform &&
    row.browser === v.browser &&
    row.viewport === v.viewport &&
    row.theme === v.theme
  );
}

export async function saveAndRediff(
  deps: ProcessDeps,
  {
    userId,
    build,
    target,
    options,
  }: {
    userId: string;
    build: Build;
    target: OverrideTarget;
    options: DiffOptions;
  },
): Promise<SavedOverride> {
  const changed = await saveOverride(deps.db, userId, build.projectId, { ...target, options });
  if (!changed) return { changed, rediffed: 0, status: build.status, note: null };
  return { changed, ...(await rediffTarget(deps, build, target, "override")) };
}

/**
 * Re-diff the open build's shots of a test (or one variant of it) after something the diff reads
 * for it changed in the review UI: an override (ob 1495) or an ignore box (ob 1499). A build with
 * no verdict yet is left to its next run, and a run that holds the build measures with it.
 */
export async function rediffTarget(
  deps: ProcessDeps,
  build: Build,
  target: OverrideTarget,
  what: string,
): Promise<Omit<SavedOverride, "changed">> {
  const unchanged = { rediffed: 0, status: build.status, note: null };
  if (!VERDICTS.includes(build.status))
    return {
      ...unchanged,
      note: `build is ${build.status}: it is measured with the ${what} on its next run`,
    };
  const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
  const ids = rows.filter((row) => applies(row, target)).map((row) => row.id);
  if (ids.length === 0) return unchanged;
  try {
    const result = await rediffShots(deps, build, ids);
    return { rediffed: ids.length, status: result.status, note: result.error };
  } catch (e) {
    // A diff run holds the build: the change is saved, and that run or the next measures with it.
    if (!(e instanceof RerunError)) throw e;
    return { ...unchanged, note: e.message };
  }
}
