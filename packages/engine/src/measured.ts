import type { DiffOptions, IgnoreRect, PixelDiff } from "./diff.ts";
import type { Raster } from "./diff-probe.ts";
import { findRegions, type BlobBoxes, type DiffField, type Region } from "./regions.ts";
import { labelShifts } from "./shift.ts";
import { clearsFloors } from "./summary.ts";
import { colourDelta, MAX_YIQ_DELTA } from "./yiq.ts";

/** Measured on bench/corpus: keeps every real change there except one-level colour steps (ob 1485). */
export const DEFAULT_THRESHOLD = 0.01;

/** What the pixel loop counted, and the field it classified the overlap into. */
export type Counts = {
  changedPixels: number;
  antialiased: number;
  ignoredPixels: number;
  ignored: IgnoreRect[];
  field: DiffField;
};

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

/** Region grouping, the shift labels and the floors. */
function groupRegions(
  field: DiffField,
  [a, b]: [Raster, Raster],
  {
    ignoredPixels,
    options,
    blobs,
  }: {
    ignoredPixels: number;
    options: DiffOptions;
    blobs: BlobBoxes | undefined;
  },
) {
  const found = findRegions(field, options, blobs);
  // The ratio floor is a share of what was measured: ignored pixels are not part of the denominator.
  const measured = field.width * field.height - ignoredPixels;
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  const regions = labelRegions(found.regions, a, b, options);
  const changed = sizeChanged || clearsFloors(regions, measured, options);
  return { regions, specks: found.specks, changed };
}

/**
 * Everything after the pixel loop: regions, shift labels, floors and the overlay's encode. The
 * WASM diff runs the loop and the blob pass itself (`blobs`). Frees nothing: the buffers are the
 * caller's.
 */
export function measuredDiff(
  [a, b]: [Raster, Raster],
  overlay: Raster,
  { changedPixels, antialiased, ignoredPixels, ignored, field }: Counts,
  {
    options = {},
    encode,
    blobs,
  }: {
    options?: DiffOptions;
    encode: (overlay: Raster) => Buffer;
    blobs?: BlobBoxes;
  },
): PixelDiff & { overlay: Buffer } {
  const { regions, specks, changed } = groupRegions(field, [a, b], {
    ignoredPixels,
    options,
    blobs,
  });
  const encoded = encode(overlay);
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
