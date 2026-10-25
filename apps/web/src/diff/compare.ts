import { Buffer } from "node:buffer";
import {
  type DiffIgnore,
  type DiffOptions,
  ENGINE_VERSION,
  type PixelDiff,
  diffPngs,
  identicalResult,
  summarizeDiff,
} from "@pixelslash/engine/diff";
import { release } from "@pixelslash/engine/release";
import type { BaselineSnapshot } from "#/db/baselines";
import type { DiffLocation, DiffResult, IgnoreRect, ResolvedDiff, snapshots } from "#/db/schema";
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
 * One comparer's diffs: in the sidecar when there is one, and in-process (WebAssembly in workerd,
 * or pngjs) when there is none or it fails. Either way the same engine measures with the same options, so the
 * result is the same; only the overlay's PNG bytes differ, as two encoders deflate the same pixels
 * differently.
 */
function measurer(
  diff: typeof diffPngs,
  url: string | undefined,
): (
  pair: [Buffer, Buffer],
  args: { options: DiffOptions | undefined; ignore: DiffIgnore },
) => Promise<PixelDiff> {
  let sidecar = sidecarOf(url);
  return async ([main, branch], { options, ignore }) => {
    if (sidecar) {
      try {
        return await sidecar(main, branch, options ?? {}, ignore);
      } catch (e) {
        if (!(e instanceof SidecarError)) throw e;
        // A file the sidecar could not diff is not its failure: pngjs says why, as on Cloudflare.
        if (e.kind !== "rejected") logFallbackOnce(e.kind, e.message);
        // Not reached once, not tried again this run: a hung sidecar costs the diff budget one
        // timeout, not one per shot.
        if (e.kind === "unreachable") sidecar = null;
      }
    }
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
