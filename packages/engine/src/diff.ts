import {
  findRegions,
  newField,
  PIXEL_ANTIALIASED,
  PIXEL_CHANGED,
  type BlobBoxes,
  type DiffField,
  type Region,
  type RegionOptions,
  type Specks,
} from "./regions.ts";
import { labelShifts, type ShiftOptions } from "./shift.ts";
import { clearsFloors } from "./summary.ts";
import { clipRects, ignoreMask } from "./ignore-mask.ts";
import { identicalBytes } from "./identical.ts";
import { colourDelta, isAntialiased, MAX_YIQ_DELTA } from "./yiq.ts";
import { clock, reportLoop, type DiffProbe, type Raster } from "./diff-probe.ts";
import { decodePng, encodePng } from "./png-codec.ts";
import { release, releasing } from "./release.ts";

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

/** Measured on bench/corpus: keeps every real change there except one-level colour steps (ob 1485). */
export const DEFAULT_THRESHOLD = 0.01;

type Counts = {
  changedPixels: number;
  antialiased: number;
  ignoredPixels: number;
  ignored: IgnoreRect[];
  field: DiffField;
};

type Overlap = {
  width: number;
  height: number;
  maxDelta: number;
  skip: Uint8Array;
  field: DiffField;
  /** Milliseconds spent in the anti-alias test; only counted when a probe is attached. */
  antialiasMs: { total: number } | null;
};

/** Classify the pixel at overlap index `at` into `o.field`; ignored pixels never get here. */
function classify(a: Raster, b: Raster, at: number, o: Overlap) {
  const x = at % o.width;
  const y = (at - x) / o.width;
  const delta = colourDelta(a.data, (y * a.width + x) << 2, b.data, (y * b.width + x) << 2);
  const field = o.field;
  if (Math.abs(delta) <= o.maxDelta) return "same";
  const timer = o.antialiasMs;
  const started = timer ? performance.now() : 0;
  const edge = isAntialiased(a, x, y, b) || isAntialiased(b, x, y, a);
  if (timer) timer.total += performance.now() - started;
  if (edge) {
    field.kind[at] = PIXEL_ANTIALIASED;
    return "antialiased";
  }
  field.kind[at] = PIXEL_CHANGED;
  field.amplitude[at] = Math.min(255, Math.round(Math.sqrt(Math.abs(delta) / MAX_YIQ_DELTA) * 255));
  field.lighter[at] = delta < 0 ? 1 : 0;
  return "changed";
}

/**
 * Diff the overlapping rectangle, painting changed pixels magenta onto `overlay`. Pixels inside
 * an ignore area are dropped before classification, so no region or speck can start in one.
 */
function diffOverlap(
  a: Raster,
  b: Raster,
  overlay: Raster,
  {
    threshold,
    ignore,
    probe,
  }: { threshold: number; ignore: DiffIgnore; probe: DiffProbe | undefined },
): Counts {
  const loopStarted = clock(probe);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const field = newField(width, height);
  const ignored = clipRects([...(ignore.main ?? []), ...(ignore.branch ?? [])], width, height);
  const skip = ignoreMask(ignored, width, height);
  const o: Overlap = {
    width,
    height,
    maxDelta: MAX_YIQ_DELTA * threshold * threshold,
    skip: skip.mask,
    field,
    antialiasMs: probe ? { total: 0 } : null,
  };
  const counts: Counts = {
    changedPixels: 0,
    antialiased: 0,
    ignoredPixels: skip.count,
    ignored,
    field,
  };
  const scanned = scanOverlap(a, b, overlay, o);
  counts.changedPixels = scanned.changedPixels;
  counts.antialiased = scanned.antialiased;
  if (probe && o.antialiasMs) reportLoop(probe, o.antialiasMs.total, loopStarted);
  return counts;
}

/** The per-pixel loop of `diffOverlap`: classify each pixel and paint the changed ones. */
function scanOverlap(a: Raster, b: Raster, overlay: Raster, o: Overlap) {
  const counts = { changedPixels: 0, antialiased: 0 };
  for (let y = 0; y < o.height; y++) {
    for (let x = 0; x < o.width; x++) {
      if (o.skip[y * o.width + x]) continue;
      const kind = classify(a, b, y * o.width + x, o);
      if (kind === "antialiased") counts.antialiased++;
      if (kind !== "changed") continue;
      counts.changedPixels++;
      overlay.data.set([255, 0, 255, 255], (y * overlay.width + x) << 2);
    }
  }
  return counts;
}

/** The regions with `shift` labels applied; none when the sizes differ (there is no common grid). */
function labelRegions(regions: Region[], a: Raster, b: Raster, options: DiffOptions): Region[] {
  if (a.width !== b.width || a.height !== b.height) return regions;
  return labelShifts(
    regions,
    {
      main: a.data,
      branch: b.data,
      width: a.width,
      height: a.height,
      maxDelta: MAX_YIQ_DELTA * (options.threshold ?? DEFAULT_THRESHOLD) ** 2,
      delta: (ia, ib) => colourDelta(a.data, ia, b.data, ib),
    },
    options,
  );
}

export function diffPngs(
  main: Buffer,
  branch: Buffer,
  options: DiffOptions = {},
  ignore: DiffIgnore = {},
): PixelDiff {
  const same = identicalBytes(main, branch);
  if (same) return same;
  const [a, b] = [decodePng(main), decodePng(branch)];
  return releasing([a.data, b.data], () => diffRasters(a, b, options, { ignore }));
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
  return diffRasters(decodePng(main), decodePng(branch), options, { ignore });
}

/** Region grouping, the shift labels and the floors, timed as `regions` when a probe is attached. */
function groupRegions(
  field: DiffField,
  [a, b]: [Raster, Raster],
  {
    ignoredPixels,
    options,
    probe,
    blobs,
  }: {
    ignoredPixels: number;
    options: DiffOptions;
    probe: DiffProbe | undefined;
    blobs: BlobBoxes | undefined;
  },
) {
  const started = clock(probe);
  const found = findRegions(field, options, blobs);
  // The ratio floor is a share of what was measured: ignored pixels are not part of the denominator.
  const measured = field.width * field.height - ignoredPixels;
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  const regions = labelRegions(found.regions, a, b, options);
  const changed = sizeChanged || clearsFloors(regions, measured, options);
  probe?.("regions", clock(probe) - started);
  return { regions, specks: found.specks, changed };
}

/**
 * `diffPngs` from decoded pixels: the benchmark decodes (and times the decoding) itself, and may
 * decode both at once. A `probe` is told how long each phase took; without one nothing is timed.
 * `encode` turns the overlay into its PNG bytes; the engine's PNG codec (pngjs, or
 * the CLI's native one) unless the benchmark measures another encoder (PS-168).
 */
export function diffRasters(
  a: Raster,
  b: Raster,
  options: DiffOptions = {},
  {
    ignore = {},
    probe,
    encode = encodePng,
  }: { ignore?: DiffIgnore; probe?: DiffProbe; encode?: (overlay: Raster) => Buffer } = {},
): PixelDiff & { overlay: Buffer } {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const overlay: Raster = { data: Buffer.alloc(width * height * 4), width, height };
  const counts = diffOverlap(a, b, overlay, {
    threshold: options.threshold ?? DEFAULT_THRESHOLD,
    ignore,
    probe,
  });
  const result = measuredDiff([a, b], overlay, counts, { options, probe, encode });
  // A caller's own `encode` may keep the overlay (the bench's capture does), so only ours is freed.
  const { field } = counts;
  release(field.kind, field.amplitude, field.lighter, encode === encodePng && overlay.data);
  return result;
}

/**
 * Everything after the pixel loop: regions, shift labels, floors and the overlay's encode. Shared
 * with the WASM diff (PS-204), which runs the loop and the blob pass itself (`blobs`) and must give
 * the same result. Frees nothing: the buffers are the caller's.
 */
export function measuredDiff(
  [a, b]: [Raster, Raster],
  overlay: Raster,
  { changedPixels, antialiased, ignoredPixels, ignored, field }: Counts,
  {
    options = {},
    probe,
    encode = encodePng,
    blobs,
  }: {
    options?: DiffOptions;
    probe?: DiffProbe | undefined;
    encode?: (overlay: Raster) => Buffer;
    blobs?: BlobBoxes;
  } = {},
): PixelDiff & { overlay: Buffer } {
  const { regions, specks, changed } = groupRegions(field, [a, b], {
    ignoredPixels,
    options,
    probe,
    blobs,
  });
  const encodeStarted = clock(probe);
  const encoded = encode(overlay);
  probe?.("overlay_encode", clock(probe) - encodeStarted);
  return {
    changed,
    ignoredPixels,
    ignored,
    changedPixels,
    antialiased,
    regions,
    specks,
    settledBy: "measured",
    overlay: encoded,
    width: overlay.width,
    height: overlay.height,
    mainWidth: a.width,
    mainHeight: a.height,
    branchWidth: b.width,
    branchHeight: b.height,
  };
}

export { type DiffSummary, changedOf, summarizeDiff } from "./summary.ts";
export { CLIENT_VERSION as ENGINE_VERSION } from "./version.ts";
