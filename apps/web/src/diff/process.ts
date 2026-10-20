import { Buffer } from "node:buffer";
import { diffPngs } from "@pixelslash/engine/diff";
import { eq } from "drizzle-orm";
import {
  type Baselines,
  type BaselineSnapshot,
  selectBaselines,
  snapshotKeyOf,
} from "#/db/baselines";
import type { Db } from "#/db/db";
import type { Build } from "#/db/builds";
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

export type ProcessDeps = { db: Db; blobs: BlobStore };

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
 * Compare one shot with its baseline. No baseline is `new`; a baseline rendered by a different
 * environment needs a re-baseline and is measured against nothing, so it never shows a wall of
 * false diffs and never blocks.
 */
async function diffOne(
  deps: ProcessDeps,
  shot: SnapshotRow,
  baseline: BaselineSnapshot | undefined,
): Promise<void> {
  if (!baseline) return storeSnapshot(deps.db, shot.id, { diffStatus: "new" });
  if (baseline.envFingerprint !== shot.envFingerprint)
    return storeSnapshot(deps.db, shot.id, {
      diffStatus: null,
      diffResult: null,
      rebaselineNeeded: true,
      baselineKey: baseline.imageKey,
    });
  const [main, branch] = await Promise.all([
    readBlob(deps.blobs, baseline.imageKey),
    readBlob(deps.blobs, shot.imageKey),
  ]);
  // The new shot's stored options; the engine's defaults fill any key it left out. The ignore
  // areas are the union of both shots', so an element that moved is covered at both places.
  const result = diffPngs(main, branch, shot.diffOptions, {
    main: baseline.ignore,
    branch: shot.ignore,
  });
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
  });
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

export type ProcessResult = { status: Build["status"]; error: string | null };

/**
 * Diff every shot of a finalised build and move it to its verdict. A build that has moved on is
 * left alone, which covers the sequential retry after a lost reply. No claim is taken: two
 * concurrent calls would each measure the build, so a client should not retry a finalise that is
 * still running.
 */
export async function processBuild(deps: ProcessDeps, build: Build): Promise<ProcessResult> {
  if (build.status !== "processing") return { status: build.status, error: build.error };
  const rows = await deps.db.select().from(snapshots).where(eq(snapshots.buildId, build.id));
  try {
    const baselines: Baselines = await selectBaselines(
      deps.db,
      build,
      new Set(rows.map(snapshotKeyOf)),
    );
    for (const shot of rows) await diffOne(deps, shot, baselines.byKey.get(snapshotKeyOf(shot)));
    await markRemoved(deps, build, baselines.removed);
    await acceptMainBuild(deps.db, build);
  } catch (e) {
    await markErrored(deps.db, build, e);
    return { status: "errored", error: e instanceof Error ? e.message : String(e) };
  }
  const status = await refreshBuildStatus(deps.db, build.id);
  return { status, error: null };
}
