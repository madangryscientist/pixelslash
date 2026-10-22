import type { Build } from "#/db/builds";
import { addIgnoreBox, clearIgnoreBox } from "#/db/ignore-boxes";
import type { OverrideTarget } from "#/db/overrides";
import type { IgnoreRect } from "#/db/schema";
import { type SavedOverride, rediffTarget } from "./override";
import type { ProcessDeps } from "./process";

/**
 * Drawing or clearing a review-UI ignore box from a shot's screen (ob 1499): store it, then re-diff
 * the open build's shots it applies to, as a saved threshold does (ob 1495). Later builds read it
 * when they are measured.
 */

export async function addBoxAndRediff(
  deps: ProcessDeps,
  {
    userId,
    build,
    target,
    rect,
  }: { userId: string; build: Build; target: OverrideTarget; rect: IgnoreRect },
): Promise<SavedOverride> {
  await addIgnoreBox(deps.db, userId, build.projectId, { ...target, rect });
  return { changed: true, ...(await rediffTarget(deps, build, target, "box")) };
}

export async function clearBoxAndRediff(
  deps: ProcessDeps,
  { userId, build, boxId }: { userId: string; build: Build; boxId: string },
): Promise<SavedOverride> {
  const target = await clearIgnoreBox(deps.db, userId, build.projectId, boxId);
  if (!target) return { changed: false, rediffed: 0, status: build.status, note: null };
  return { changed: true, ...(await rediffTarget(deps, build, target, "box cleared")) };
}
