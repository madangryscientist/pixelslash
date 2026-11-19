import { Buffer } from "node:buffer";
import {
  type DiffIgnore,
  type DiffOptions,
  ENGINE_VERSION,
  type PixelDiff,
  diffPngs,
  diffPngsBanded,
  identicalResult,
  readPngSize,
  summarizeDiff,
} from "@hackcove/pixelslash-engine/diff";
import { release } from "@hackcove/pixelslash-engine/release";
import type { BaselineSnapshot } from "#/db/baselines";
import type { DiffLocation, DiffResult, IgnoreRect, ResolvedDiff, snapshots } from "#/db/schema";
import { msBetween } from "#/db/server-timings";
import { snapshotStem } from "#/db/stem";
import type { BlobStore } from "#/storage/blobs";
import { callGate } from "./call-gate";
import { checkCiResult } from "./ci-result";

/**
 * The two ways a shot is compared with a baseline (ob 1727): measured here with the engine, or
 * read from the result a CI run sent. `process.ts` stores either the same way.
 */

export type SnapshotRow = typeof snapshots.$inferSelect;

async function readBlob(blobs: BlobStore, key: string): Promise<Buffer> {
  const stream = await blobs.get(key);
  if (!stream) throw new Error(`image ${key} is missing from storage`);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/**
 * The diff image's key sits beside the shot it belongs to: under the shot's own stem
 * (`snapshotStem`), never its `imageKey`. A shot stored by hash (PS-424) shares another build's
 * `imageKey`, so a key derived from that would make two builds write one overlay. For a shot that
 * sent its PNG the stem and the `imageKey` agree, so its key is what it always was.
 */
export function diffKeyOf(stem: string): string {
  return `${stem}.diff.png`;
}

/** One comparison of a shot with one baseline, before it is stored. */
export type Measured = {
  changed: boolean;
  diffResult: DiffResult;
  /**
   * Where the overlay is, or null when there is none: the shots were the same bytes, so none was
   * drawn (ob 1948). The server writes its own only when the comparison is stored.
   */
  diffKey: () => Promise<string | null>;
  measuredBy: DiffLocation;
  engineVersion: string;
  /**
   * Milliseconds from this shot's first compare starting to now (PS-233); read once its overlay is
   * written. Only the server's own compares carry it: a CI result was not measured here.
   */
  compareMs?: () => number;
  /** The uploads' hashes matched, so no compare ran: a cache hit is counted and never timed (PS-336). */
  cacheHit?: true;
};

export type Comparer = (shot: SnapshotRow, baseline: BaselineSnapshot) => Promise<Measured>;

/** The rects of a shot's review-UI ignore boxes (ob 1499), as the engine takes them. */
function uiRects(resolved: ResolvedDiff | null): IgnoreRect[] {
  return (resolved?.ignore ?? []).map(({ x, y, width, height }) => ({ x, y, width, height }));
}

/** The shared size of two shots whose uploads hashed the same, or null when that is not known. */
function sameBytes(
  shot: SnapshotRow,
  baseline: BaselineSnapshot,
): { width: number; height: number } | null {
  if (!shot.imageSha256 || shot.imageSha256 !== baseline.imageSha256) return null;
  return shot.imageSize && baseline.imageSize ? shot.imageSize : null;
}

/**
 * A shot over a size limit: an outcome of what was uploaded, not a server fault (PS-328), so it is
 * stored and shown but never reported. A re-run cannot help it.
 */
export class DiffRefusedError extends Error {
  override name = "DiffRefusedError";
}

/**
 * Refuse a pair above `limit` Mpx, by the box both PNGs fit in (PS-323), in words the build's error
 * shows. Memory follows the pixels (~30 MB per Mpx on top of what the app holds), so this is an
 * admission check: an allocation failure inside the diff is already too late. A PNG with no size
 * is the diff's to report.
 */
function refuseOver(limit: number, main: Buffer, branch: Buffer): void {
  const a = readPngSize(main);
  const b = readPngSize(branch);
  if (!a || !b) return;
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const mpx = (width * height) / 1_000_000;
  if (mpx > limit)
    throw new DiffRefusedError(
      `too large for a server diff on this server: ${width}x${height} = ${mpx.toFixed(1)} Mpx, limit ${limit} Mpx`,
    );
}

/**
 * One server diff at a time in this isolate (PS-464). The diff runs on the thread that answers every
 * request, in bands with a pause between them (`diffPngsBanded`), so a page asked for during a long
 * diff waits for one band, not the whole diff. Each diff in flight holds a wasm instance of its own,
 * as large as its shots, so they take turns: two tall diffs at once would double that memory and
 * halve each one's share of the thread for no gain. A diff renews its turn's lease at every pause,
 * so a diff whose request the runtime cancelled at a pause (its `finally` never runs) frees the turn
 * within the lease, and a live one keeps it however long it takes. The lease is far above one band.
 */
const oneDiff = callGate(1, 15_000);

type Diff = (
  main: Buffer,
  branch: Buffer,
  options?: DiffOptions,
  ignore?: DiffIgnore,
) => PixelDiff | Promise<PixelDiff>;

const bandedDiff: Diff = (main, branch, options, ignore) =>
  oneDiff((renew) =>
    // Lets every request that is ready run before the next band: a timer, not a microtask.
    diffPngsBanded(main, branch, {
      options,
      ignore,
      pause: () => {
        renew();
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    }),
  );

/** The server diff: both PNGs read and measured here, in-process, a band at a time. */
export function serverComparer(deps: {
  blobs: BlobStore;
  /** Stands in for the engine's diff in a test; unset is the banded diff. */
  diff?: typeof diffPngs | undefined;
  /**
   * The self-host's admission limit in Mpx, `DIFF_LIMIT_MPX`: a pair over it errors the build
   * naming the size. Unset (Cloudflare, which has its own limits) admits every shot.
   */
  diffLimitMpx?: number | undefined;
}): Comparer {
  const diff: Diff = deps.diff ?? bandedDiff;
  const limit = deps.diffLimitMpx;
  return async (shot, baseline) => {
    // The same bytes, known from the uploads' hashes: unchanged, with nothing read and no overlay.
    // A shot without a hash or a size (older, or a marker) is read like any other.
    const size = sameBytes(shot, baseline);
    if (size)
      return {
        changed: false,
        diffResult: summarizeDiff(identicalResult(size)),
        measuredBy: "server",
        engineVersion: ENGINE_VERSION,
        diffKey: async () => null,
        cacheHit: true,
      };
    const [main, branch] = await Promise.all([
      readBlob(deps.blobs, baseline.imageKey),
      readBlob(deps.blobs, shot.imageKey),
    ]);
    // The new shot's options, with the project's review-UI overrides laid over them when
    // `measureAll` resolved them (ob 1495); the engine's defaults fill any key left out. The ignore
    // areas are the union of both shots', so an element that moved is covered at both places, and
    // of the boxes drawn on the test in the review UI (ob 1499).
    let result: PixelDiff;
    try {
      if (limit !== undefined) refuseOver(limit, main, branch);
      result = await diff(main, branch, shot.resolvedDiff?.options ?? shot.diffOptions, {
        main: baseline.ignore,
        branch: [...shot.ignore, ...uiRects(shot.resolvedDiff)],
      });
    } finally {
      // The uploads are read once and dead now. A Worker has no gc(): freed here, a burst of
      // full-page shots does not leave workerd holding gigabytes until it restarts (PS-200).
      release(main, branch);
    }
    return {
      changed: result.changed,
      diffResult: summarizeDiff(result),
      measuredBy: "server",
      engineVersion: ENGINE_VERSION,
      diffKey: async () => {
        // `diff` may itself settle on the bytes (the engine's shortcut): no overlay then either.
        if (!result.overlay) return null;
        const key = diffKeyOf(await snapshotStem(shot));
        // One bulk copy, not a view: a blob store takes an ArrayBuffer, and a Buffer may be a view
        // into a pooled one. The overlay of a full-page shot is ~20 MB against a Worker's 128 MB.
        const png = new Uint8Array(result.overlay);
        await deps.blobs.put(key, png.buffer, "image/png");
        return key;
      },
    };
  };
}

/**
 * One shot's comparer, timed (PS-233) from `started`, the moment the budget began the shot: every
 * compare it makes, the carry path's two included, counts from there. Read after the overlay's
 * write: workerd advances its clock only at I/O, so the diff's own CPU time shows up once the next
 * write returns. A cache hit stays untimed (PS-336), also when the carry path's first compare ran:
 * the shot is the same bytes as the baseline it stores, and readers leave those out of every time.
 */
export function timedComparer(compare: Comparer, now: () => number, started: number): Comparer {
  return async (shot, baseline) => {
    const measured = await compare(shot, baseline);
    if (measured.cacheHit) return measured;
    return { ...measured, compareMs: () => msBetween(started, now()) };
  };
}

/** A PNG's size from its IHDR header, the only part of the baseline a CI check reads. */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24) throw new Error("the baseline is too short to be a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * A CI project's comparison: the result the CLI sent for this baseline, checked against the
 * baseline's own size, never re-measured. The baseline is read for its header and not decoded.
 */
export function ciComparer(blobs: BlobStore): Comparer {
  return async (shot, baseline) => {
    const size = pngSize(await readBlob(blobs, baseline.imageKey));
    const checked = checkCiResult(shot.ciResults, { id: baseline.id, size }, shot.diffOptions);
    return {
      changed: checked.changed,
      diffResult: checked.diffResult,
      measuredBy: "ci",
      engineVersion: checked.engineVersion,
      diffKey: async () => checked.diffKey,
    };
  };
}
