import { Buffer } from "node:buffer";
import { diffPngs } from "@pixelslash/engine/diff";
import { and, eq, isNull, lt, or } from "drizzle-orm";
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
import { type DiffResult, builds, snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";

/**
 * The server diff (ob 1470): when a build is finalised, pick each shot's baseline and measure it
 * with the engine's diff — the same code the CLI runs, so a run here and a run there agree. The
 * server adds only the things the engine does not know about: which baseline, which stored
 * options and ignore areas, and the build status.
 */

/** A build on this branch is auto-accepted: there is no reviewer to ask. */
export const MAIN_BRANCH = "main";

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

type SnapshotRow = typeof snapshots.$inferSelect;

async function readBlob(blobs: BlobStore, key: string): Promise<Buffer> {
  const stream = await blobs.get(key);
  if (!stream) throw new Error(`image ${key} is missing from storage`);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/** The diff image's key sits beside the shot it belongs to. */
function diffKeyOf(imageKey: string): string {
  return `${imageKey.replace(/\.png$/, "")}.diff.png`;
}

/** The engine's result, minus the overlay (its own blob) and the fields the UI derives. */
function summarize(result: ReturnType<typeof diffPngs>): DiffResult {
  return {
    changedPixels: result.changedPixels,
    antialiasedPixels: result.antialiased,
    ignoredPixels: result.ignoredPixels,
    ignored: result.ignored,
    specks: result.specks,
    regions: result.regions,
    // The engine's `width`/`height` are the overlay canvas (the larger of the two); the overlap
    // it actually measured is the smaller, and that is what the report must state.
    width: Math.min(result.mainWidth, result.branchWidth),
    height: Math.min(result.mainHeight, result.branchHeight),
    mainWidth: result.mainWidth,
    mainHeight: result.mainHeight,
    branchWidth: result.branchWidth,
    branchHeight: result.branchHeight,
    sizeChanged:
      result.mainWidth !== result.branchWidth || result.mainHeight !== result.branchHeight,
  };
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
          carriedFrom: null,
        }
      : {
          diffStatus: "new",
          diffResult: null,
          diffKey: null,
          baselineKey: null,
          rebaselineNeeded: false,
          carriedFrom: null,
        },
  );
  if (shot.diffKey) await deps.blobs.delete(shot.diffKey);
}

async function compare(deps: ProcessDeps, shot: SnapshotRow, baseline: BaselineSnapshot) {
  const [main, branch] = await Promise.all([
    readBlob(deps.blobs, baseline.imageKey),
    readBlob(deps.blobs, shot.imageKey),
  ]);
  // The new shot's stored options; the engine's defaults fill any key it left out. The ignore
  // areas are the union of both shots', so an element that moved is covered at both places.
  return diffPngs(main, branch, shot.diffOptions, {
    main: baseline.ignore,
    branch: shot.ignore,
  });
}

/** Store a comparison: the shot it was against, and the open change it carries, if any (ob 1712). */
async function storeDiff(
  deps: ProcessDeps,
  shot: SnapshotRow,
  result: ReturnType<typeof diffPngs>,
  against: { baseline: BaselineSnapshot; carriedFrom: string | null },
): Promise<void> {
  const { baseline, carriedFrom } = against;
  const diffKey = diffKeyOf(shot.imageKey);
  // One bulk copy, not a view: a blob store takes an ArrayBuffer, and a Buffer may be a view
  // into a pooled one. The overlay of a full-page shot is ~20 MB against a Worker's 128 MB.
  const png = new Uint8Array(result.overlay);
  await deps.blobs.put(diffKey, png.buffer, "image/png");
  await storeSnapshot(deps.db, shot.id, {
    baselineKey: baseline.imageKey,
    diffKey,
    diffStatus: result.changed ? "changed" : "unchanged",
    diffResult: summarize(result),
    rebaselineNeeded: false,
    carriedFrom,
  });
}

async function measureAgainst(
  deps: ProcessDeps,
  shot: SnapshotRow,
  baseline: BaselineSnapshot | undefined,
): Promise<void> {
  if (!baseline || baseline.envFingerprint !== shot.envFingerprint)
    return storeUncompared(deps, shot, baseline);
  await storeDiff(deps, shot, await compare(deps, shot, baseline), { baseline, carriedFrom: null });
}

/**
 * Compare one shot with its baseline. When the baseline holds an undecided change (ob 1712), an
 * identical shot carries that change and one that differs is measured against the accepted shot,
 * so a reviewer is always shown the change against an image someone accepted.
 */
async function diffOne(
  deps: ProcessDeps,
  shot: SnapshotRow,
  baseline: Baseline | undefined,
): Promise<void> {
  if (!baseline?.carry) return measureAgainst(deps, shot, baseline?.shot);
  if (baseline.shot.envFingerprint === shot.envFingerprint) {
    const result = await compare(deps, shot, baseline.shot);
    if (!result.changed)
      return storeDiff(deps, shot, result, {
        baseline: baseline.shot,
        carriedFrom: baseline.carry,
      });
  }
  await measureAgainst(deps, shot, baseline.accepted);
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

async function acceptMainBuild(db: Db, build: Build): Promise<void> {
  if (build.branch !== MAIN_BRANCH) return;
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
 * How long a `processing` build is presumed alive. A run killed mid-diff (the isolate hits its
 * 30 s CPU limit on a build of several whole-page changes, or the Worker is evicted) never gets
 * to write `errored`, so its build would read `processing` for ever. Nothing heartbeats, so age
 * is the only evidence of death: a build claimed longer ago than this has no live run, and the
 * next finalise may take it over. It must outlast any run that is still going — the request is
 * capped at 30 s of CPU, and R2 waits add wall time, not CPU — and stay short enough that a
 * client retrying finalise is not left waiting on a corpse. Five minutes is ten times the cap.
 *
 * The claim is a lease without a fence: a run still alive past the bound would be overwritten by
 * its successor's verdict. That is a choice; fencing every write is more than this needs.
 */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/**
 * Take the build for one diff run, or learn that someone else holds it. One conditional UPDATE,
 * so of two concurrent calls only one wins. A build is claimable when it errored, when it was
 * finalised and no run has started (null), or when its run began more than the bound ago.
 */
async function claim(db: Db, build: Build): Promise<boolean> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimed = await db
    .update(builds)
    .set({ status: "processing", error: null, processingStartedAt: new Date() })
    .where(
      and(
        eq(builds.id, build.id),
        or(
          eq(builds.status, "errored"),
          and(
            eq(builds.status, "processing"),
            or(isNull(builds.processingStartedAt), lt(builds.processingStartedAt, cutoff)),
          ),
        ),
      ),
    )
    .returning({ id: builds.id });
  return claimed.length > 0;
}

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
    await diffOne(deps, shot, baseline);
    diffed++;
    slowest = Math.max(slowest, now() - began);
  }
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
  if (!(await claim(deps.db, build))) {
    const current = await getBuild(deps.db, build.projectId, build.id);
    return { status: current.status, error: current.error, unmeasured: 0 };
  }
  try {
    await clearMarkers(deps, build);
    const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
    const baselines: Baselines = await selectBaselines(
      deps.db,
      build,
      new Set(rows.map(snapshotKeyOf)),
    );
    await measure(deps, rows, baselines);
    await markRemoved(deps, build, baselines.removed);
    await acceptMainBuild(deps.db, build);
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
