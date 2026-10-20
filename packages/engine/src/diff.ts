import { PNG } from "pngjs";
import {
  findRegions,
  newField,
  PIXEL_ANTIALIASED,
  PIXEL_CHANGED,
  type DiffField,
  type Region,
  type RegionOptions,
  type Specks,
} from "./regions.ts";

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
} & RegionOptions;

export type PixelDiff = {
  /** The verdict: sizes differ, or a `change` region survives and the changed pixels clear the floors. */
  changed: boolean;
  /** Pixels in the overlap that differ and are not anti-aliased edges. */
  changedPixels: number;
  /** Differing pixels that are anti-aliased edges in either shot; not counted as changed. */
  antialiased: number;
  /** Boxes of the changed pixels in the overlap, largest first; `noise` ones do not make a run changed. */
  regions: Region[];
  /** Boxes dropped for being below `minRegionArea`: counted, never silently lost. */
  specks: Specks;
  overlay: Buffer;
  width: number;
  height: number;
  mainWidth: number;
  mainHeight: number;
  branchWidth: number;
  branchHeight: number;
};

/** Measured on bench/corpus: keeps every real change there except one-level colour steps (ob 1485). */
export const DEFAULT_THRESHOLD = 0.01;

/** Largest YIQ delta (squared, weighted) between black and white. */
const MAX_YIQ_DELTA = 35215;

type Raster = { data: Uint8Array; width: number; height: number };

function lumaIq(data: Uint8Array, i: number): [number, number, number] {
  let r = data[i] ?? 0;
  let g = data[i + 1] ?? 0;
  let b = data[i + 2] ?? 0;
  const a = (data[i + 3] ?? 0) / 255;
  if (a < 1) {
    r = 255 + (r - 255) * a;
    g = 255 + (g - 255) * a;
    b = 255 + (b - 255) * a;
  }
  return [
    r * 0.29889531 + g * 0.58662247 + b * 0.11448223,
    r * 0.59597799 - g * 0.2741761 - b * 0.32180189,
    r * 0.21147017 - g * 0.52261711 + b * 0.31114694,
  ];
}

/** Perceptual distance between two pixels, signed: negative when `b` is the lighter one. */
function colourDelta(a: Uint8Array, ia: number, b: Uint8Array, ib: number): number {
  const same =
    a[ia] === b[ib] &&
    a[ia + 1] === b[ib + 1] &&
    a[ia + 2] === b[ib + 2] &&
    a[ia + 3] === b[ib + 3];
  if (same) return 0;
  const [ya, ia_, qa] = lumaIq(a, ia);
  const [yb, ib_, qb] = lumaIq(b, ib);
  const dy = ya - yb;
  const di = ia_ - ib_;
  const dq = qa - qb;
  const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
  return dy > 0 ? -delta : delta;
}

/** Brightness difference of a neighbour against the centre pixel of the same shot. */
function brightnessDelta(d: Uint8Array, centre: number, neighbour: number): number {
  return lumaIq(d, centre)[0] - lumaIq(d, neighbour)[0];
}

function sameRgba(d: Uint8Array, a: number, b: number): boolean {
  return d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3];
}

/** In-bounds 8-neighbourhood of (x, y), as [x, y] pairs. */
function neighbours(img: Raster, x: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, img.height - 1); ny++) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, img.width - 1); nx++) {
      if (nx !== x || ny !== y) out.push([nx, ny]);
    }
  }
  return out;
}

/** More than two of the 8 neighbours share the pixel's exact colour: it sits in a flat area. */
function hasManySiblings(img: Raster, x: number, y: number): boolean {
  const at = (y * img.width + x) << 2;
  const same = neighbours(img, x, y).filter(([nx, ny]) =>
    sameRgba(img.data, at, (ny * img.width + nx) << 2),
  );
  return same.length > 2;
}

type Extreme = { delta: number; x: number; y: number };

/**
 * Whether (x, y) is an anti-aliased edge pixel of `img` (Vysniauskas, "On the detection of
 * anti-aliased pixels", 2009): its neighbours run both darker and lighter, few match it, and the
 * extreme neighbour sits in a flat area in both shots, i.e. the edge is a real, hard one.
 */
function isAntialiased(img: Raster, x: number, y: number, other: Raster): boolean {
  const centre = (y * img.width + x) << 2;
  let equal = 0;
  const min: Extreme = { delta: 0, x: 0, y: 0 };
  const max: Extreme = { delta: 0, x: 0, y: 0 };
  for (const [nx, ny] of neighbours(img, x, y)) {
    const delta = brightnessDelta(img.data, centre, (ny * img.width + nx) << 2);
    if (delta === 0) equal++;
    else if (delta < min.delta) Object.assign(min, { delta, x: nx, y: ny });
    else if (delta > max.delta) Object.assign(max, { delta, x: nx, y: ny });
  }
  if (equal > 2 || min.delta === 0 || max.delta === 0) return false;
  const flatBoth = (e: Extreme) =>
    hasManySiblings(img, e.x, e.y) && hasManySiblings(other, e.x, e.y);
  return flatBoth(min) || flatBoth(max);
}

type Counts = { changedPixels: number; antialiased: number; field: DiffField };

/** Diff the overlapping rectangle, painting changed pixels magenta onto `overlay`. */
function diffOverlap(a: PNG, b: PNG, threshold: number, overlay: PNG): Counts {
  const maxDelta = MAX_YIQ_DELTA * threshold * threshold;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const field = newField(width, height);
  const counts: Counts = { changedPixels: 0, antialiased: 0, field };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const delta = colourDelta(a.data, (y * a.width + x) << 2, b.data, (y * b.width + x) << 2);
      if (Math.abs(delta) <= maxDelta) continue;
      const at = y * width + x;
      if (isAntialiased(a, x, y, b) || isAntialiased(b, x, y, a)) {
        counts.antialiased++;
        field.kind[at] = PIXEL_ANTIALIASED;
        continue;
      }
      counts.changedPixels++;
      field.kind[at] = PIXEL_CHANGED;
      field.amplitude[at] = Math.min(
        255,
        Math.round(Math.sqrt(Math.abs(delta) / MAX_YIQ_DELTA) * 255),
      );
      field.lighter[at] = delta < 0 ? 1 : 0;
      const io = (y * overlay.width + x) << 2;
      overlay.data.set([255, 0, 255, 255], io);
    }
  }
  return counts;
}

export function diffPngs(main: Buffer, branch: Buffer, options: DiffOptions = {}): PixelDiff {
  const a = PNG.sync.read(main);
  const b = PNG.sync.read(branch);
  const overlay = new PNG({
    width: Math.max(a.width, b.width),
    height: Math.max(a.height, b.height),
  });
  const { changedPixels, antialiased, field } = diffOverlap(
    a,
    b,
    options.threshold ?? DEFAULT_THRESHOLD,
    overlay,
  );
  const { regions, specks } = findRegions(field, options);
  const overlap = field.width * field.height;
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  const surviving = regions
    .filter((r) => r.kind === "change")
    .reduce((n, r) => n + r.changedPixels, 0);
  const clearsFloors =
    surviving > 0 &&
    surviving >= (options.minChangedPixels ?? 0) &&
    surviving / overlap >= (options.minChangedRatio ?? 0);
  return {
    changed: sizeChanged || clearsFloors,
    changedPixels,
    antialiased,
    regions,
    specks,
    overlay: PNG.sync.write(overlay),
    width: overlay.width,
    height: overlay.height,
    mainWidth: a.width,
    mainHeight: a.height,
    branchWidth: b.width,
    branchHeight: b.height,
  };
}
