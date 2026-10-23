import type { diffPngs } from "@pixelslash/engine/diff";
import { eq } from "drizzle-orm";
import {
  type Baseline,
  type Baselines,
  type BaselineSnapshot,
  selectBaselines,
  snapshotKeyOf,
} from "#/db/baselines";
import type { Db } from "#/db/db";
import { type Build, getBuild } from "#/db/builds";
import { refreshBuildStatus } from "#/db/review";
import { snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import { CiResultError } from "./ci-result";
import { NoRecoveryError, claim, dead } from "./claim";
import {
  type Comparer,
  type Measured,
  type SnapshotRow,
  ciComparer,
  diffKeyOf,
  serverComparer,
} from "./compare";
import { measureAgainstMain } from "./against-main";
import { Budget, runStart } from "./budget";
import {
  type ProjectOfBuild,
  acceptDefaultBranchBuild,
  clearMarkers,
  markErrored,
  markRemoved,
  projectOf,
} from "./build-writes";
import { withOverrides } from "./with-overrides";
import { explainBuild } from "#/ai/explain";
import { summarizeBuild } from "#/ai/summary";
import type { ModelFetch } from "#/ai/model";

export { NoRecoveryError, STALE_PROCESSING_MS } from "./claim";

/**
 * The server diff (ob 1470): when a build is finalised, pick each shot's baseline and measure it
 * with the engine's diff — the same code the CLI runs, so a run here and a run there agree. The
 * server adds only the things the engine does not know about: which baseline, which stored
 * options and ignore areas, and the build status.
 *
 * A project that diffs in CI (ob 1727) runs none of the diff here: the CLI measured each shot
 * against the baseline this same pick gave it, and the server checks and stores what it sent
 * (`ci-result.ts`). Every shot of a build is measured in one place; a CI result that is missing,
 * malformed or measured against another baseline errors the shot and the build, and is never
 * diffed here instead.
 */

export { DIFF_BUDGET_MS } from "./budget";

export type ProcessDeps = {
  db: Db;
  blobs: BlobStore;
  /** The clock the budget reads; a test passes a fake one. workerd advances it at I/O, and each shot ends in a blob write. */
  now?: (() => number) | undefined;
  /** The engine's diff; a test passes one that throws to prove a CI build never calls it. */
  diff?: typeof diffPngs | undefined;
  /** The transport to the project's model (ob 1473); a test passes a stub. */
  modelFetch?: ModelFetch | undefined;
};

/**
 * This run stopped before the Worker's limit with shots left. Not a failure to start over from:
 * what was measured is kept, and the next finalise measures only the rest (ob 1645).
 */
export class DiffCeilingError extends Error {
  readonly unmeasured: number;
  constructor(measured: number, total: number, usedMs: number, slowestMs: number) {
    super(
      `diff ceiling: measured ${measured} of ${total} shots (${total - measured} left); this run ` +
        `used ${(usedMs / 1000).toFixed(1)} s (slowest shot ${(slowestMs / 1000).toFixed(1)} s) ` +
        `and the next could pass the Worker's 30 s CPU limit. Finalise again to measure the rest.`,
    );
    this.name = "DiffCeilingError";
    this.unmeasured = total - measured;
  }
}

async function storeSnapshot(
  db: Db,
  id: string,
  fields: Partial<typeof snapshots.$inferInsert>,
): Promise<void> {
  await db.update(snapshots).set(fields).where(eq(snapshots.id, id));
}

/**
 * A shot with nothing to compare against. No baseline is `new`; a baseline rendered by a
 * different environment needs a re-baseline and is measured against nothing, so it never shows
 * a wall of false diffs and never blocks.
 */
async function storeUncompared(
  deps: ProcessDeps,
  shot: SnapshotRow,
  baseline: BaselineSnapshot | undefined,
): Promise<void> {
  // A shot measured again against another baseline may have had an overlay; one that now has no
  // overlay to write drops it.
  await storeSnapshot(
    deps.db,
    shot.id,
    baseline
      ? {
          diffStatus: null,
          diffResult: null,
          diffKey: null,
          rebaselineNeeded: true,
          baselineKey: baseline.imageKey,
          baselineSnapshotId: baseline.id,
          carriedFrom: null,
          measuredBy: null,
          engineVersion: null,
          diffError: null,
          aiReview: null,
        }
      : {
          diffStatus: "new",
          diffResult: null,
          diffKey: null,
          baselineKey: null,
          baselineSnapshotId: null,
          rebaselineNeeded: false,
          carriedFrom: null,
          measuredBy: null,
          engineVersion: null,
          diffError: null,
          aiReview: null,
        },
  );
  // Only the server's own overlay goes; a mask a CI run uploaded is part of the upload, like the shot.
  if (shot.diffKey === diffKeyOf(shot.imageKey)) await deps.blobs.delete(shot.diffKey);
}

/** Store a comparison: the shot it was against, and the open change it carries, if any (ob 1712). */
async function storeDiff(
  deps: ProcessDeps,
  shot: SnapshotRow,
  measured: Measured,
  against: { baseline: BaselineSnapshot; carriedFrom: string | null },
): Promise<void> {
  const { baseline, carriedFrom } = against;
  await storeSnapshot(deps.db, shot.id, {
    baselineKey: baseline.imageKey,
    baselineSnapshotId: baseline.id,
    diffKey: await measured.diffKey(),
    diffStatus: measured.changed ? "changed" : "unchanged",
    diffResult: measured.diffResult,
    rebaselineNeeded: false,
    carriedFrom,
    measuredBy: measured.measuredBy,
    engineVersion: measured.engineVersion,
    diffError: null,
    // An explanation was of the result this one replaces (ob 1473).
    aiReview: null,
  });
}

async function measureAgainst(
  deps: ProcessDeps,
  compare: Comparer,
  shot: SnapshotRow,
  baseline: BaselineSnapshot | undefined,
): Promise<void> {
  if (!baseline || baseline.envFingerprint !== shot.envFingerprint)
    return storeUncompared(deps, shot, baseline);
  await storeDiff(deps, shot, await compare(shot, baseline), { baseline, carriedFrom: null });
}

/**
 * Compare one shot with its baseline. When the baseline holds an undecided change (ob 1712), an
 * identical shot carries that change and one that differs is measured against the accepted shot,
 * so a reviewer is always shown the change against an image someone accepted.
 */
async function diffOne(
  deps: ProcessDeps,
  compare: Comparer,
  shot: SnapshotRow,
  baseline: Baseline | undefined,
): Promise<void> {
  if (!baseline?.carry) return measureAgainst(deps, compare, shot, baseline?.shot);
  if (baseline.shot.envFingerprint === shot.envFingerprint) {
    const measured = await compare(shot, baseline.shot);
    if (!measured.changed)
      return storeDiff(deps, shot, measured, {
        baseline: baseline.shot,
        carriedFrom: baseline.carry,
      });
  }
  await measureAgainst(deps, compare, shot, baseline.accepted);
}

export type ProcessResult = {
  status: Build["status"];
  error: string | null;
  /** Shots a finalise sent again would still measure; non-zero only when the budget stopped the run. */
  unmeasured: number;
};

/**
 * Whether a shot's stored result still stands. It does when it was measured (a status, or a
 * re-baseline that measured nothing) against the baseline that would be picked now, carrying the
 * change that would be carried now. The baseline is chosen from other builds' shots, and one can
 * be accepted or decided between two runs; a shot measured against another baseline is measured
 * again, so a resumed build ends with the verdict a single run would have given. A shot's own
 * image, options and ignore areas cannot change: the build is closed to uploads once finalised. A
 * review-UI override can (ob 1495), and `withOverrides` clears a result it moved before this runs.
 */
function stands(shot: SnapshotRow, baseline: Baseline | undefined): boolean {
  if (shot.diffStatus === null && !shot.rebaselineNeeded) return false;
  if (shot.baselineKey === (baseline?.shot.imageKey ?? null))
    return shot.carriedFrom === (baseline?.carry ?? null);
  return measuredPastCarry(shot, baseline);
}

/** Measured against the accepted shot because it differed from an undecided one (`diffOne`). */
function measuredPastCarry(shot: SnapshotRow, baseline: Baseline | undefined): boolean {
  if (!baseline?.carry || shot.carriedFrom !== null) return false;
  return shot.baselineKey === (baseline.accepted?.imageKey ?? null);
}

/**
 * Measure the shots whose stored result no longer stands, under this run's budget. Throws
 * `DiffCeilingError` when the budget stops it with shots left; what it measured stays stored.
 */
async function measure(
  deps: ProcessDeps,
  rows: SnapshotRow[],
  baselines: Baselines,
  budget: Budget,
) {
  const compare = serverComparer(deps);
  const failed: string[] = [];
  let done = 0;
  for (const shot of rows) {
    const baseline = baselines.byKey.get(snapshotKeyOf(shot));
    if (!stands(shot, baseline)) {
      if (!budget.fits())
        throw new DiffCeilingError(done, rows.length, budget.used(), budget.slowest);
      await budget.spend(async () => {
        const reason = await diffOrRecord(deps, compare, shot, baseline);
        if (reason) failed.push(reason);
      });
    }
    done++;
  }
  if (failed.length > 0)
    throw new Error(
      `${failed.length} of ${rows.length} shots could not be measured; re-run them from the build ` +
        `page. ${failed.join("; ")}`,
    );
}

const shotLabel = (shot: SnapshotRow) => `${shot.name} (${shot.viewport}, ${shot.theme})`;

/**
 * Measure one shot on the server; one whose diff throws (its baseline missing from storage, a PNG
 * that does not decode) keeps the reason in `diff_error` and is left unmeasured, and the others are
 * still measured (ob 1738). The build errors naming it, and a re-run measures only what is left.
 */
async function diffOrRecord(
  deps: ProcessDeps,
  compare: Comparer,
  shot: SnapshotRow,
  baseline: Baseline | undefined,
): Promise<string | null> {
  try {
    await diffOne(deps, compare, shot, baseline);
    return null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await storeSnapshot(deps.db, shot.id, {
      diffStatus: null,
      diffResult: null,
      rebaselineNeeded: false,
      diffError: reason,
    });
    return `${shotLabel(shot)}: ${reason}`;
  }
}

/**
 * Store the results a CI run sent (ob 1727). No PNG is read and no budget applies: each shot is a
 * check of some JSON. A shot whose result is refused keeps the reason in `diff_error` and is left
 * unmeasured; the others are stored, and the build errors naming every refused shot.
 */
async function measureFromCi(deps: ProcessDeps, rows: SnapshotRow[], baselines: Baselines) {
  const refused: string[] = [];
  for (const shot of rows) {
    const baseline = baselines.byKey.get(snapshotKeyOf(shot));
    if (stands(shot, baseline)) continue;
    try {
      await diffOne(deps, ciComparer(deps.blobs), shot, baseline);
    } catch (e) {
      if (!(e instanceof CiResultError)) throw e;
      await storeSnapshot(deps.db, shot.id, { diffStatus: null, diffError: e.message });
      refused.push(`${shotLabel(shot)}: ${e.message}`);
    }
  }
  if (refused.length > 0)
    throw new Error(
      `this project diffs in CI and ${refused.length} of ${rows.length} shots have no usable result; ` +
        `re-run the CI job. ${refused.join("; ")}`,
    );
}

/**
 * Measure every shot against its own baseline, in CI's results or here under the run's budget,
 * then a branch build's against main with what that budget leaves (ob 1723). Only the server diff
 * reads the review-UI overrides; a CI project's results are measured with the config alone.
 */
export async function measureAll(
  deps: ProcessDeps,
  { build, project, only }: { build: Build; project: ProjectOfBuild; only?: Set<string> },
  rows: SnapshotRow[],
  baselines: Baselines,
) {
  const budget = project.diffLocation === "ci" ? null : new Budget(deps.now ?? Date.now);
  if (budget)
    await measure(deps, await withOverrides(deps.db, build.projectId, rows), baselines, budget);
  else await measureFromCi(deps, rows, baselines);
  if (build.branch !== project.defaultBranch)
    await measureAgainstMain(deps, { buildId: build.id, only }, baselines, budget);
}

/**
 * Another run holds the build: its status. A CI project's build whose run died is not run again
 * (`claim`), so it is ended here, naming what to do.
 */
async function heldElsewhere(db: Db, build: Build, ci: boolean): Promise<ProcessResult> {
  const current = await getBuild(db, build.projectId, build.id);
  if (ci && dead(current)) {
    const died = "the run measuring this build died; re-run the CI job";
    await markErrored(db, current, new Error(died));
    return { status: "errored", error: died, unmeasured: 0 };
  }
  return { status: current.status, error: current.error, unmeasured: 0 };
}

/**
 * Diff the shots of a finalised build that have no result and move it to its verdict. It takes `processing` (just
 * finalised), `errored` (a retry after a failure such as a transient R2 miss) and a `processing`
 * build whose run died (see `STALE_PROCESSING_MS`); any other build has moved on and is left
 * alone. The take is atomic, so a finalise retried while a run is live gets that run's status
 * back instead of a second, racing diff.
 *
 * A build too big for one run's budget is resumed, not restarted (ob 1645): a run measures what
 * the budget allows and ends the build `errored` naming how many are left, and the next one keeps
 * what stands (`stands`) and measures the rest. The build is never given a verdict while a shot is
 * unmeasured. The budget is per run, so a run always measures at least one shot and repeated
 * finalises reach the end.
 *
 * The verdict write is inside the try (ob 1561): a status write that throws must end the build at
 * `errored` with the reason, never leave it looking like it is still being measured.
 */
export async function processBuild(deps: ProcessDeps, build: Build): Promise<ProcessResult> {
  if (build.status !== "processing" && build.status !== "errored")
    return { status: build.status, error: build.error, unmeasured: 0 };
  const project = await projectOf(deps.db, build);
  const ci = project.diffLocation === "ci";
  if (ci && build.status === "errored") throw new NoRecoveryError();
  if (!(await claim(deps.db, build, ci))) return heldElsewhere(deps.db, build, ci);
  try {
    const startedAt = runStart(deps.now);
    await clearMarkers(deps, build);
    const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
    const baselines: Baselines = await selectBaselines(
      deps.db,
      build,
      new Set(rows.map(snapshotKeyOf)),
    );
    await measureAll(deps, { build, project }, rows, baselines);
    await markRemoved(deps, build, baselines.removed);
    await acceptDefaultBranchBuild(deps.db, build, project);
    const status = await refreshBuildStatus(deps.db, build.id);
    // After the verdict, so a run the Worker stops while the model is asked has already given one.
    const passed = await explainBuild(deps, build, { startedAt });
    const final = passed === 0 ? status : await refreshBuildStatus(deps.db, build.id);
    // Text for the reviewer (ob 1668), last: the verdict is written before the call, and it never
    // throws, so a stopped call or a failed write cannot change the verdict or mark the build errored.
    await summarizeBuild(deps, build, { startedAt });
    return { status: final, error: null, unmeasured: 0 };
  } catch (e) {
    await markErrored(deps.db, build, e);
    // The ceiling's count includes shots a changed baseline sends back to be measured again, which
    // a count of rows with no result would miss.
    const unmeasured = e instanceof DiffCeilingError ? e.unmeasured : 0;
    return { status: "errored", error: e instanceof Error ? e.message : String(e), unmeasured };
  }
}
