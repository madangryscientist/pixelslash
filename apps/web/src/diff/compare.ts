import { Buffer } from "node:buffer";
import {
  type DiffIgnore,
  type DiffOptions,
  ENGINE_VERSION,
  type PixelDiff,
  diffPngs,
  identicalResult,
  readPngSize,
  summarizeDiff,
} from "@hackcove/pixelslash-engine/diff";
import { release } from "@hackcove/pixelslash-engine/release";
import type { BaselineSnapshot } from "#/db/baselines";
import type { DiffLocation, DiffResult, IgnoreRect, ResolvedDiff, snapshots } from "#/db/schema";
import { msBetween } from "#/db/server-timings";
import type { BlobStore } from "#/storage/blobs";
import { checkCiResult } from "./ci-result";
import {
  type SidecarDiff,
  SidecarError,
  logFallbackOnce,
  sidecarDiff,
  sidecarEndpoint,
} from "./sidecar";

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

/** The diff image's key sits beside the shot it belongs to. */
export function diffKeyOf(imageKey: string): string {
  return `${imageKey.replace(/\.png$/, "")}.diff.png`;
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
 * The self-host's sidecar when one is named, else none (PS-203). Unset is logged once: Cloudflare
 * never sets it, and a self-host that meant to can see it did not. A URL that is not on loopback is
 * refused, and the shots stay in-process.
 */
function sidecarOf(url: string | undefined): SidecarDiff | null {
  if (!url) {
    logFallbackOnce("unset", "DIFF_SIDECAR_URL is not set");
    return null;
  }
  const endpoint = sidecarEndpoint(url);
  if (endpoint) return sidecarDiff(endpoint);
  logFallbackOnce("refused", `DIFF_SIDECAR_URL ${url} is not an http URL on loopback`);
  return null;
}

/**
 * The largest shot a self-host diffs, by the box both PNGs fit in (PS-323): ~1280x19000, twice the
 * largest shot in the PS-214 corpus. Memory follows the pixels (~30 MB per Mpx), so this is what
 * `pixelslash-diff.service`'s MemoryMax is sized from: an admission check, because an allocation
 * failure inside the diff is already too late.
 */
const SIDECAR_LIMIT_MPX = 24.5;
/**
 * The largest shot workerd diffs when the sidecar fails (PS-323): 1280x9500 fits. A diff adds ~30 MB
 * per Mpx on top of everything the app already holds, so a sidecar timeout must not add a full tall
 * diff to it; on 2026-11-05 that is what kept the review app from answering.
 */
const FALLBACK_LIMIT_MPX = 12.5;

/**
 * A shot over a size limit: an outcome of what was uploaded, not a server fault (PS-328), so it is
 * stored and shown but never reported. A re-run cannot help it.
 */
export class DiffRefusedError extends Error {
  override name = "DiffRefusedError";
}

/** Refuse a pair above `limit`, in words the build's error shows. A PNG with no size is the diff's to report. */
function refuseOver(what: string, limit: number, main: Buffer, branch: Buffer): void {
  const a = readPngSize(main);
  const b = readPngSize(branch);
  if (!a || !b) return;
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const mpx = (width * height) / 1_000_000;
  if (mpx > limit)
    throw new DiffRefusedError(
      `${what}: ${width}x${height} = ${mpx.toFixed(1)} Mpx, limit ${limit} Mpx`,
    );
}

/**
 * One comparer's diffs: in the sidecar when there is one, and in-process when there is none or it
 * fails. Both run the same `diff.wasm` with the same options (PS-210), so the result is the same.
 * With a sidecar configured both are bounded (PS-323), and a shot over a limit throws, which errors
 * the build naming it (`diffOrRecord`). Without one nothing changes: Cloudflare has its own limits.
 */
function measurer(
  diff: typeof diffPngs,
  url: string | undefined,
): (
  pair: [Buffer, Buffer],
  args: { options: DiffOptions | undefined; ignore: DiffIgnore },
) => Promise<PixelDiff> {
  let sidecar = sidecarOf(url);
  const bounded = Boolean(url);
  return async ([main, branch], { options, ignore }) => {
    if (bounded) refuseOver("too large for a server diff", SIDECAR_LIMIT_MPX, main, branch);
    if (sidecar) {
      try {
        return await sidecar(main, branch, options ?? {}, ignore);
      } catch (e) {
        if (!(e instanceof SidecarError)) throw e;
        // A file the sidecar could not diff is not its failure: the in-process diff says why, as on Cloudflare.
        if (e.kind !== "rejected") logFallbackOnce(e.kind, e.message);
        // Not reached once, not tried again this run: a hung sidecar costs the diff budget one
        // timeout, not one per shot.
        if (e.kind === "unreachable") sidecar = null;
      }
    }
    if (bounded)
      refuseOver(
        "too large for an in-process diff without the diff sidecar",
        FALLBACK_LIMIT_MPX,
        main,
        branch,
      );
    return diff(main, branch, options, ignore);
  };
}

/** The server diff: both PNGs read here, and measured here or in the self-host's sidecar. */
export function serverComparer(deps: {
  blobs: BlobStore;
  diff?: typeof diffPngs | undefined;
  /** The self-host's diff sidecar (PS-203), `DIFF_SIDECAR_URL`; unset measures in-process. */
  diffSidecar?: string | undefined;
}): Comparer {
  const measure = measurer(deps.diff ?? diffPngs, deps.diffSidecar);
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
      result = await measure([main, branch], {
        options: shot.resolvedDiff?.options ?? shot.diffOptions,
        ignore: { main: baseline.ignore, branch: [...shot.ignore, ...uiRects(shot.resolvedDiff)] },
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
        const key = diffKeyOf(shot.imageKey);
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
