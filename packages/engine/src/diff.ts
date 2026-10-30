import type { RegionOptions, Region, Specks } from "./regions.ts";
import type { ShiftOptions } from "./shift.ts";
import { identicalBytes } from "./identical.ts";
import { wasmDiff } from "./diff-wasm.ts";

export { identicalResult, readPngSize } from "./identical.ts";

export type DiffOptions = {
  /**
   * Per-pixel tolerance, 0 to 1. 0 flags every differing pixel; larger values ignore small
   * perceptual colour differences (YIQ distance, alpha blended over white).
   */
  threshold?: number;
  /** A run with fewer changed pixels than this is not `changed`. Counts are still reported. */
  minChangedPixels?: number;
  /** A run with a smaller changed share of the overlap (0 to 1) is not `changed`. */
  minChangedRatio?: number;
} & RegionOptions &
  ShiftOptions;

/** A rectangle in image pixels (the top-left origin of the PNG). */
export type IgnoreRect = { x: number; y: number; width: number; height: number };

/**
 * Areas the diff does not measure: the real pixels stay in the shots. The diff skips the union of
 * both lists, so an element that moved is covered at its old and its new place.
 */
export type DiffIgnore = { main?: IgnoreRect[]; branch?: IgnoreRect[] };

/**
 * `measured`: the pixels were decoded and compared. `identical-bytes`: both PNGs were the same
 * bytes, so nothing was decoded, compared or drawn. Never claims more than was done.
 */
export type SettledBy = "measured" | "identical-bytes";

export type PixelDiff = {
  /** The verdict: sizes differ, or a `change` region survives and the changed pixels clear the floors. */
  changed: boolean;
  /** Pixels of the overlap inside an ignore area: skipped, neither changed nor unchanged. */
  ignoredPixels: number;
  /** The ignore areas, clipped to the overlap; what the report hatches. */
  ignored: IgnoreRect[];
  /** Pixels in the overlap that differ and are not anti-aliased edges. */
  changedPixels: number;
  /** Differing pixels that are anti-aliased edges in either shot; not counted as changed. */
  antialiased: number;
  /** Boxes of the changed pixels in the overlap, largest first; `noise` and `shift` ones do not make a run changed. */
  regions: Region[];
  /** Boxes dropped for being below `minRegionArea`: counted, never silently lost. */
  specks: Specks;
  /** How the verdict was reached: measured pixel by pixel, or settled by the shots being the same bytes. */
  settledBy: SettledBy;
  /** The diff image; null when `settledBy` is `identical-bytes`, which draws none. */
  overlay: Buffer | null;
  width: number;
  height: number;
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
};

export { DEFAULT_THRESHOLD } from "./measured.ts";

/**
 * Diff two PNGs: the decode, the pixel loop and the overlay run in `diff.wasm` (`wasmDiff`, the
 * only diff since PS-210). Two files that are the same bytes settle without decoding anything.
 */
export function diffPngs(
  main: Buffer,
  branch: Buffer,
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
): PixelDiff {
  return identicalBytes(main, branch) ?? wasmDiff([main, branch], { options, ignore });
}

/**
 * `diffPngs` without the identical-bytes shortcut: always decodes and always draws an overlay, so
 * its `overlay` is set. For a caller whose contract needs the image (a CI run's mask, ob 1727).
 */
export function measurePngs(
  main: Buffer,
  branch: Buffer,
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
): PixelDiff & { overlay: Buffer } {
  return wasmDiff([main, branch], { options, ignore });
}

export { type DiffSummary, changedOf, summarizeDiff } from "./summary.ts";
export { CLIENT_VERSION as ENGINE_VERSION } from "./version.ts";
