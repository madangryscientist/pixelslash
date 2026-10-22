import { Buffer } from "node:buffer";
import { ENGINE_VERSION, diffPngs, summarizeDiff } from "@pixelslash/engine/diff";
import type { BaselineSnapshot } from "#/db/baselines";
import type { DiffLocation, DiffResult, snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
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

/** The diff image's key sits beside the shot it belongs to. */
export function diffKeyOf(imageKey: string): string {
  return `${imageKey.replace(/\.png$/, "")}.diff.png`;
}

/** One comparison of a shot with one baseline, before it is stored. */
export type Measured = {
  changed: boolean;
  diffResult: DiffResult;
  /** Where the overlay is. The server writes its own only when the comparison is stored. */
  diffKey: () => Promise<string>;
  measuredBy: DiffLocation;
  engineVersion: string;
};

export type Comparer = (shot: SnapshotRow, baseline: BaselineSnapshot) => Promise<Measured>;

/** The server diff: both PNGs read and measured here. */
export function serverComparer(deps: {
  blobs: BlobStore;
  diff?: typeof diffPngs | undefined;
}): Comparer {
  const diff = deps.diff ?? diffPngs;
  return async (shot, baseline) => {
    const [main, branch] = await Promise.all([
      readBlob(deps.blobs, baseline.imageKey),
      readBlob(deps.blobs, shot.imageKey),
    ]);
    // The new shot's stored options; the engine's defaults fill any key it left out. The ignore
    // areas are the union of both shots', so an element that moved is covered at both places.
    const result = diff(main, branch, shot.diffOptions, {
      main: baseline.ignore,
      branch: shot.ignore,
    });
    return {
      changed: result.changed,
      diffResult: summarizeDiff(result),
      measuredBy: "server",
      engineVersion: ENGINE_VERSION,
      diffKey: async () => {
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
