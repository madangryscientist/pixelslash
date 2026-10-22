import type { diffPngs } from "@pixelslash/engine/diff";
import { and, eq } from "drizzle-orm";
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
import { type DiffLocation, builds, projects, snapshots } from "#/db/schema";
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

/**
 * The Worker's CPU limit is 30 s and the diff runs inline in the finalise request (decided
 * 2026-10-20: inline for beta). A kill by the runtime cannot be caught, so the build stops itself
 * first: this is the share of that limit the shots may use, which leaves the rest for the baseline
 * pick, the removed markers and the verdict. Wall time stands in for CPU time, so it only errs
 * early.
 */
export const DIFF_BUDGET_MS = 25_000;

export type ProcessDeps = {
  db: Db;
  blobs: BlobStore;
  /** The clock the budget reads; a test passes a fake one. workerd advances it at I/O, and each shot ends in a blob write. */
  now?: (() => number) | undefined;
  /** The engine's diff; a test passes one that throws to prove a CI build never calls it. */
  diff?: typeof diffPngs | undefined;
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

/** A shot the baseline build had and this one does not: a marker row, so reviewers can see it. */
async function markRemoved(deps: ProcessDeps, build: Build, removed: BaselineSnapshot[]) {
  for (const shot of removed) {
    await deps.db
      .insert(snapshots)
      .values({
        id: crypto.randomUUID(),
        buildId: build.id,
        name: shot.name,
        platform: shot.platform,
        browser: shot.browser,
        viewport: shot.viewport,
        theme: shot.theme,
        envFingerprint: shot.envFingerprint,
        ignore: shot.ignore,
        imageKey: shot.imageKey,
        baselineKey: shot.imageKey,
        diffStatus: "removed",
      })
      .onConflictDoNothing();
  }
}

type ProjectOfBuild = { defaultBranch: string; diffLocation: DiffLocation };

async function projectOf(db: Db, build: Build): Promise<ProjectOfBuild> {
  const [project] = await db
    .select({ defaultBranch: projects.defaultBranch, diffLocation: projects.diffLocation })
    .from(projects)
    .where(eq(projects.id, build.projectId));
  if (!project) throw new Error("the build's project is gone");
  return project;
}

/** A build on the project's default branch is auto-accepted: there is no reviewer to ask (ob 1559). */
async function acceptDefaultBranchBuild(
  db: Db,
  build: Build,
  project: ProjectOfBuild,
): Promise<void> {
  if (build.branch !== project.defaultBranch) return;
  await db
    .update(snapshots)
    .set({ reviewState: "accepted", reviewedAt: new Date() })
    .where(eq(snapshots.buildId, build.id));
}

async function markErrored(db: Db, build: Build, e: unknown): Promise<void> {
  const error = e instanceof Error ? e.message : String(e);
  await db.update(builds).set({ status: "errored", error }).where(eq(builds.id, build.id));
}

export type ProcessResult = {
  status: Build["status"];
  error: string | null;
  /** Shots a finalise sent again would still measure; non-zero only when the budget stopped the run. */
  unmeasured: number;
};

/**
 * Drop the removed markers an earlier run wrote; the run writes the ones the baseline calls for.
 * Everything else an earlier run stored stays, so a re-run resumes instead of starting over
 * (ob 1645). The uploaded shots are what usage counts and are never touched.
 */
async function clearMarkers(deps: ProcessDeps, build: Build): Promise<void> {
  await deps.db
    .delete(snapshots)
    .where(and(eq(snapshots.buildId, build.id), eq(snapshots.diffStatus, "removed")));
}

/**
 * Whether a shot's stored result still stands. It does when it was measured (a status, or a
 * re-baseline that measured nothing) against the baseline that would be picked now, carrying the
 * change that would be carried now. The baseline is chosen from other builds' shots, and one can
 * be accepted or decided between two runs; a shot measured against another baseline is measured
 * again, so a resumed build ends with the verdict a single run would have given. A shot's own
 * image, options and ignore areas cannot change: the build is closed to uploads once finalised.
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
 * The budget is per run and its first shot always goes, so every run makes progress.
 */
async function measure(deps: ProcessDeps, rows: SnapshotRow[], baselines: Baselines) {
  const compare = serverComparer(deps);
  const now = deps.now ?? Date.now;
  const started = now();
  let slowest = 0;
  let diffed = 0;
  let kept = 0;
  for (const shot of rows) {
    const baseline = baselines.byKey.get(snapshotKeyOf(shot));
    if (stands(shot, baseline)) {
      kept++;
      continue;
    }
    // Stop before a shot that, if it costs as much as the slowest so far, would pass the limit.
    const used = now() - started;
    if (diffed > 0 && used + slowest > DIFF_BUDGET_MS)
      throw new DiffCeilingError(kept + diffed, rows.length, used, slowest);
    const began = now();
    await diffOne(deps, compare, shot, baseline);
    diffed++;
    slowest = Math.max(slowest, now() - began);
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
      refused.push(`${shot.name} (${shot.viewport}, ${shot.theme}): ${e.message}`);
    }
  }
  if (refused.length > 0)
    throw new Error(
      `this project diffs in CI and ${refused.length} of ${rows.length} shots have no usable result; ` +
        `re-run the CI job. ${refused.join("; ")}`,
    );
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
    await clearMarkers(deps, build);
    const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
    const baselines: Baselines = await selectBaselines(
      deps.db,
      build,
      new Set(rows.map(snapshotKeyOf)),
    );
    if (ci) await measureFromCi(deps, rows, baselines);
    else await measure(deps, rows, baselines);
    await markRemoved(deps, build, baselines.removed);
    await acceptDefaultBranchBuild(deps.db, build, project);
    const status = await refreshBuildStatus(deps.db, build.id);
    return { status, error: null, unmeasured: 0 };
  } catch (e) {
    await markErrored(deps.db, build, e);
    // The ceiling's count includes shots a changed baseline sends back to be measured again, which
    // a count of rows with no result would miss.
    const unmeasured = e instanceof DiffCeilingError ? e.unmeasured : 0;
    return { status: "errored", error: e instanceof Error ? e.message : String(e), unmeasured };
  }
}
