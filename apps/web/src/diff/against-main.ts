import type { diffPngs } from "@pixelslash/engine/diff";
import { eq } from "drizzle-orm";
import { type BaselineSnapshot, type Baselines, snapshotKeyOf } from "#/db/baselines";
import type { Db } from "#/db/db";
import { snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import type { Budget } from "./budget";
import { type Comparer, type SnapshotRow, serverComparer } from "./compare";

/**
 * A branch shot against main (ob 1723), for the branch page's final review: the newest accepted
 * shot of another branch at the merge-base (`Baselines.main`), measured once by the diff that
 * measured the shot against its own baseline, and stored beside that result. It is never a review
 * state itself, but a shot unchanged against its previous build that still differs from main and
 * was never accepted carries an open change, and that keeps the build at `changes` (PS-284,
 * `diff/open-vs-main.ts`). Only the result is stored, not an
 * overlay: the page draws its boxes from `mainDiffResult`.
 */

type MainFields = Pick<
  typeof snapshots.$inferInsert,
  "mainBaselineKey" | "mainDiffStatus" | "mainDiffResult"
>;

const notMeasured: MainFields = {
  mainBaselineKey: null,
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

/** Whether the stored result against main still stands for this pick, so a resumed run does not measure it again. */
export function mainStands(shot: SnapshotRow, main: BaselineSnapshot | undefined): boolean {
  if (shot.mainBaselineKey !== (main?.imageKey ?? null)) return false;
  if (!main) return shot.mainDiffStatus === "new";
  if (main.envFingerprint !== shot.envFingerprint) return shot.mainDiffStatus === null;
  return shot.mainDiffStatus !== null;
}

async function against(
  compare: Comparer | null,
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
      mainDiffStatus: shot.diffStatus,
      mainDiffResult: shot.diffResult,
    };
  // A CI run measures each shot against its own pick only: one that cannot reuse its own diff is
  // not measured against main, and is never diffed here instead.
  if (!compare) return { ...notMeasured, mainBaselineKey: main.imageKey };
  const measured = await compare(shot, main);
  return {
    mainBaselineKey: main.imageKey,
    mainDiffStatus: measured.changed ? "changed" : "unchanged",
    mainDiffResult: measured.diffResult,
  };
}

/** Measure one shot against main and store it. */
export async function diffAgainstMain(
  deps: { db: Db },
  compare: Comparer | null,
  shot: SnapshotRow,
  main: BaselineSnapshot | undefined,
): Promise<void> {
  const fields = await against(compare, shot, main);
  await deps.db.update(snapshots).set(fields).where(eq(snapshots.id, shot.id));
}

/**
 * Measure a branch build's shots against main (ob 1723), after their own diff and from what it
 * stored. It never errors the build: what the budget leaves unmeasured stays null, and the branch
 * page says "not measured against main". What it does measure decides the verdict only through
 * `carryOpenFromMain` (PS-284), which reads the stored result afterwards.
 */
export async function measureAgainstMain(
  deps: {
    db: Db;
    blobs: BlobStore;
    diff?: typeof diffPngs | undefined;
    diffSidecar?: string | undefined;
  },
  { buildId, only }: { buildId: string; only?: Set<string> | undefined },
  baselines: Baselines,
  budget: Budget | null,
) {
  const compare = budget ? serverComparer(deps) : null;
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
