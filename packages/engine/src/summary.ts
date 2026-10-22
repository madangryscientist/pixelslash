import type { DiffOptions, IgnoreRect, PixelDiff } from "./diff.ts";
import type { Region, Specks } from "./regions.ts";

/** A `change` region survives and its changed pixels clear both floors; `measured` excludes ignored pixels. */
export function clearsFloors(regions: Region[], measured: number, options: DiffOptions): boolean {
  const surviving = regions
    .filter((r) => r.kind === "change")
    .reduce((n, r) => n + r.changedPixels, 0);
  return (
    surviving > 0 &&
    surviving >= (options.minChangedPixels ?? 0) &&
    surviving / measured >= (options.minChangedRatio ?? 0)
  );
}

/**
 * What a diff measured, minus the overlay: the shape the server stores and a CI run sends it
 * (ob 1727). `width`/`height` are the overlap that was measured, not the overlay canvas.
 */
export type DiffSummary = {
  changedPixels: number;
  antialiasedPixels: number;
  ignoredPixels: number;
  ignored: IgnoreRect[];
  specks: Specks;
  regions: Region[];
  width: number;
  height: number;
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
  sizeChanged: boolean;
};

/** The one summary of a diff, so the server and the CLI store the same thing for the same pair. */
export function summarizeDiff(result: PixelDiff): DiffSummary {
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

/** The verdict `diffPngs` gives, read back from its summary: how a server checks a result it did not measure. */
export function changedOf(summary: DiffSummary, options: DiffOptions = {}): boolean {
  const measured = summary.width * summary.height - summary.ignoredPixels;
  return summary.sizeChanged || clearsFloors(summary.regions, measured, options);
}
