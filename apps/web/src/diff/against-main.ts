import type { diffPngs } from "@pixelslash/engine/diff";
import { eq } from "drizzle-orm";
import { type BaselineSnapshot, type Baselines, snapshotKeyOf } from "#/db/baselines";
import type { Db } from "#/db/db";
import { snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import { CiResultError } from "./ci-result";
import type { Budget } from "./budget";
import {
  type Comparer,
  type SnapshotRow,
  ciComparer,
  mainDiffKeyOf,
  serverComparer,
} from "./compare";

/**
 * A branch shot against main (ob 1723), for the branch page's final review: the newest accepted
 * shot of another branch at the merge-base (`Baselines.main`), measured once by the diff that
 * measured the shot against its own baseline, and stored beside that result. Nothing reads it to
 * decide a build: it is never a review state and never blocks.
 */

type MainFields = Pick<
  typeof snapshots.$inferInsert,
  "mainBaselineKey" | "mainDiffKey" | "mainDiffStatus" | "mainDiffResult"
>;

const notMeasured: MainFields = {
  mainBaselineKey: null,
  mainDiffKey: null,
  mainDiffStatus: null,
  mainDiffResult: null,
};

/** The shot's own diff already is against main: it is copied, not measured twice. */
function reusable(shot: SnapshotRow, main: BaselineSnapshot): boolean {
  return (
    shot.baselineKey === main.imageKey &&
    shot.carriedFrom === null &&
    (shot.diffStatus === "changed" || shot.diffStatus === "unchanged")
  );
}

/**
 * Whether the stored result against main still stands for this pick, so a resumed run does not
 * measure it again. One copied from the shot's own diff stands only while that diff is against
 * main: a re-run that measured the shot against another baseline rewrote the overlay they share.
 */
export function mainStands(shot: SnapshotRow, main: BaselineSnapshot | undefined): boolean {
  if (shot.mainBaselineKey !== (main?.imageKey ?? null)) return false;
  if (!main) return shot.mainDiffStatus === "new";
  if (main.envFingerprint !== shot.envFingerprint) return shot.mainDiffStatus === null;
  if (shot.mainDiffStatus === null) return false;
  return shot.mainDiffKey !== shot.diffKey || reusable(shot, main);
}

async function against(
  compare: Comparer,
  shot: SnapshotRow,
  main: BaselineSnapshot | undefined,
): Promise<MainFields> {
  if (!main) return { ...notMeasured, mainDiffStatus: "new" };
  // A different environment would be a wall of false diffs: the page says it was not measured.
  if (main.envFingerprint !== shot.envFingerprint)
    return { ...notMeasured, mainBaselineKey: main.imageKey };
  if (reusable(shot, main))
    return {
      mainBaselineKey: main.imageKey,
      mainDiffKey: shot.diffKey,
      mainDiffStatus: shot.diffStatus,
      mainDiffResult: shot.diffResult,
    };
  try {
    const measured = await compare(shot, main);
    return {
      mainBaselineKey: main.imageKey,
      mainDiffKey: await measured.diffKey(),
      mainDiffStatus: measured.changed ? "changed" : "unchanged",
      mainDiffResult: measured.diffResult,
    };
  } catch (e) {
    // A CI run measures each shot against its own pick only; with no result for main the shot is
    // not measured against main, and is never diffed here instead.
    if (e instanceof CiResultError) return notMeasured;
    throw e;
  }
}

/** Measure one shot against main and store it, dropping an overlay against main it no longer has. */
export async function diffAgainstMain(
  deps: { db: Db; blobs: BlobStore },
  compare: Comparer,
  shot: SnapshotRow,
  main: BaselineSnapshot | undefined,
): Promise<void> {
  const fields = await against(compare, shot, main);
  await deps.db.update(snapshots).set(fields).where(eq(snapshots.id, shot.id));
  const overlay = mainDiffKeyOf(shot.imageKey);
  if (shot.mainDiffKey === overlay && fields.mainDiffKey !== overlay)
    await deps.blobs.delete(overlay);
}

/**
 * Measure a branch build's shots against main (ob 1723), after their own diff and from what it
 * stored. It never decides the build, so it never errors it either: what the budget leaves
 * unmeasured stays null, and the branch page says "not measured against main".
 */
export async function measureAgainstMain(
  deps: { db: Db; blobs: BlobStore; diff?: typeof diffPngs | undefined },
  { buildId, only }: { buildId: string; only?: Set<string> | undefined },
  baselines: Baselines,
  budget: Budget | null,
) {
  const compare = budget ? serverComparer(deps, mainDiffKeyOf) : ciComparer(deps.blobs);
  const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, buildId));
  for (const shot of rows) {
    // A partial re-run (ob 1738) measures only the shots it was given.
    if (only && !only.has(shot.id)) continue;
    const main = baselines.main.get(snapshotKeyOf(shot));
    if (mainStands(shot, main)) continue;
    if (budget && !budget.fits()) return;
    const work = () => diffAgainstMain(deps, compare, shot, main);
    await (budget ? budget.spend(work) : work());
  }
}
