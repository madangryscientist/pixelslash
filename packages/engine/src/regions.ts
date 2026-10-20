/**
 * Changed regions (ob 1486): the differing pixels of a diff, clustered into boxes. A region is a
 * box a reviewer can look at; a box too small to be anything but a speck is counted and dropped;
 * a box that is faint, uneven and moves both ways (compression, hinting, emoji noise) is kept and
 * labelled `noise`, so it is visible but does not make the run `changed`.
 */

export const PIXEL_CHANGED = 1;
export const PIXEL_ANTIALIASED = 2;

/** Per-pixel result of the diff over the overlapping rectangle. */
export type DiffField = {
  width: number;
  height: number;
  /** PIXEL_NONE, PIXEL_CHANGED or PIXEL_ANTIALIASED. */
  kind: Uint8Array;
  /** Colour distance of a changed pixel, 0 to 255 (the same scale as `threshold`, 0 to 1). */
  amplitude: Uint8Array;
  /** 1 when Branch is lighter than Main at a changed pixel. */
  lighter: Uint8Array;
};

export function newField(width: number, height: number): DiffField {
  const n = width * height;
  return {
    width,
    height,
    kind: new Uint8Array(n),
    amplitude: new Uint8Array(n),
    lighter: new Uint8Array(n),
  };
}

export type RegionKind = "change" | "noise" | "shift";

export type Region = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Changed pixels inside the box (anti-aliased edge pixels are not counted). */
  changedPixels: number;
  /** Differing pixels inside the box that are anti-aliased edges. */
  antialiasedPixels: number;
  /** `noise` and `shift` regions are kept for the reviewer but do not make a run changed. */
  kind: RegionKind;
  /** Why a `noise` or `shift` region was called so; absent on a `change`. */
  why?: string;
};

export type RegionOptions = {
  /** Changed pixels, and then boxes, closer than this many pixels belong to one region. */
  mergeDistance?: number;
  /** A box with a smaller area (w * h) is a speck: counted, not a region. */
  minRegionArea?: number;
  /**
   * A region whose changed pixels are faint (the 90th percentile of their colour distance, 0 to 1,
   * is at most this), strong nowhere (none above twice this), uneven (not one colour delta) and move
   * both lighter and darker is noise. 0 turns the call off.
   */
  noiseAmplitude?: number;
};

export type Specks = { count: number; pixels: number };

export type RegionResult = { regions: Region[]; specks: Specks };

export const DEFAULT_MERGE_DISTANCE = 24;
export const DEFAULT_MIN_REGION_AREA = 4;
export const DEFAULT_NOISE_AMPLITUDE = 0.25;
/** The share of a region's changed pixels moving the minority way, below which it is one-way. */
const MIN_MIXED_SHARE = 0.2;
/** Noise scatters amplitudes (compression: 0.4 and up); a moved flat element has one colour delta (0). */
const MIN_AMPLITUDE_SPREAD = 0.3;

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Dilate a mask by `gap` along one axis. */
function dilateAxis(
  src: Uint8Array,
  axis: { lines: number; len: number; lineStride: number; stride: number },
  gap: number,
): Uint8Array {
  const { lines, len, lineStride, stride } = axis;
  const out = new Uint8Array(src.length);
  for (let line = 0; line < lines; line++) {
    const at = (p: number) => line * lineStride + p * stride;
    let last = -Infinity;
    for (let p = 0; p < len; p++) {
      if (src[at(p)]) last = p;
      if (p - last <= gap) out[at(p)] = 1;
    }
    last = Infinity;
    for (let p = len - 1; p >= 0; p--) {
      if (src[at(p)]) last = p;
      if (last - p <= gap) out[at(p)] = 1;
    }
  }
  return out;
}

/** The changed mask dilated by `gap` in x then y, so pixels that are near one another touch. */
function dilatedChanged(field: DiffField, gap: number): Uint8Array {
  const { width, height, kind } = field;
  const changed = new Uint8Array(kind.length);
  for (let i = 0; i < kind.length; i++) changed[i] = kind[i] === PIXEL_CHANGED ? 1 : 0;
  const wide = dilateAxis(
    changed,
    { lines: height, len: width, lineStride: width, stride: 1 },
    gap,
  );
  return dilateAxis(wide, { lines: width, len: height, lineStride: 1, stride: width }, gap);
}

type Flood = { field: DiffField; blob: Uint8Array; seen: Uint8Array };

function grow(box: Box | null, x: number, y: number): Box {
  if (!box) return { x0: x, y0: y, x1: x, y1: y };
  return {
    x0: Math.min(box.x0, x),
    y0: Math.min(box.y0, y),
    x1: Math.max(box.x1, x),
    y1: Math.max(box.y1, y),
  };
}

/** Push the unseen blob cells in the 8-neighbourhood of (x, y) onto `stack`, marking them seen. */
function pushNeighbours(flood: Flood, at: { x: number; y: number }, stack: number[]): void {
  const { blob, seen, field } = flood;
  const { width, height } = field;
  const ys = [Math.max(at.y - 1, 0), Math.min(at.y + 1, height - 1)] as const;
  const xs = [Math.max(at.x - 1, 0), Math.min(at.x + 1, width - 1)] as const;
  for (let ny = ys[0]; ny <= ys[1]; ny++) {
    for (let nx = xs[0]; nx <= xs[1]; nx++) {
      const next = ny * width + nx;
      if (!blob[next] || seen[next]) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
}

/** Flood the 8-connected blob at `start`; the box of the changed pixels in it, if any. */
function floodBox(flood: Flood, start: number): Box | null {
  const { field, seen } = flood;
  const stack = [start];
  let box: Box | null = null;
  seen[start] = 1;
  while (stack.length > 0) {
    const at = stack.pop() ?? 0;
    const x = at % field.width;
    const y = (at - x) / field.width;
    if (field.kind[at] === PIXEL_CHANGED) box = grow(box, x, y);
    pushNeighbours(flood, { x, y }, stack);
  }
  return box;
}

/** Bounding boxes of the changed pixels in each 8-connected blob of `blob`. */
function blobBoxes(field: DiffField, blob: Uint8Array): Box[] {
  const flood: Flood = { field, blob, seen: new Uint8Array(blob.length) };
  const boxes: Box[] = [];
  for (let start = 0; start < blob.length; start++) {
    if (!blob[start] || flood.seen[start]) continue;
    const box = floodBox(flood, start);
    if (box) boxes.push(box);
  }
  return boxes;
}

/** Whether two boxes overlap or are no more than `gap` pixels apart on both axes. */
function near(a: Box, b: Box, gap: number): boolean {
  return a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;
}

/** The first pair of boxes that overlap or sit within `gap` of one another, if any. */
function nearPair(boxes: Box[], gap: number): [number, number] | null {
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    const j = a ? boxes.findIndex((b, k) => k > i && near(a, b, gap)) : -1;
    if (j > i) return [i, j];
  }
  return null;
}

/** Merge boxes that overlap or sit within `gap` of one another, until none do. */
function mergeBoxes(boxes: Box[], gap: number): Box[] {
  const out = [...boxes];
  for (let pair = nearPair(out, gap); pair; pair = nearPair(out, gap)) {
    const [i, j] = pair;
    const a = out[i];
    const b = out[j];
    if (!a || !b) break;
    out[i] = {
      x0: Math.min(a.x0, b.x0),
      y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1),
      y1: Math.max(a.y1, b.y1),
    };
    out.splice(j, 1);
  }
  return out;
}

type BoxStats = {
  changedPixels: number;
  antialiasedPixels: number;
  /** Changed pixels where Branch is lighter than Main. */
  lighterPixels: number;
  /** How many changed pixels there are at each amplitude, 0 to 255. */
  amplitudes: Uint32Array;
};

function boxStats(field: DiffField, box: Box): BoxStats {
  const stats: BoxStats = {
    changedPixels: 0,
    antialiasedPixels: 0,
    lighterPixels: 0,
    amplitudes: new Uint32Array(256),
  };
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const at = y * field.width + x;
      const k = field.kind[at];
      if (k === PIXEL_ANTIALIASED) stats.antialiasedPixels++;
      if (k !== PIXEL_CHANGED) continue;
      stats.changedPixels++;
      stats.lighterPixels += field.lighter[at] ?? 0;
      const bin = field.amplitude[at] ?? 0;
      stats.amplitudes[bin] = (stats.amplitudes[bin] ?? 0) + 1;
    }
  }
  return stats;
}

/** The amplitude (0 to 255) at or below which `share` of the changed pixels fall. */
function amplitudeAt(stats: BoxStats, share: number): number {
  const target = Math.ceil(stats.changedPixels * share);
  let seen = 0;
  for (let a = 0; a < 256; a++) {
    seen += stats.amplitudes[a] ?? 0;
    if (seen >= target) return a;
  }
  return 255;
}

/** Standard deviation of the changed pixels' amplitudes over their mean: 0 when every one moved by the same colour delta. */
function amplitudeSpread(stats: BoxStats): number {
  let sum = 0;
  let sumSquares = 0;
  for (let a = 0; a < 256; a++) {
    const n = stats.amplitudes[a] ?? 0;
    sum += n * a;
    sumSquares += n * a * a;
  }
  const mean = sum / stats.changedPixels;
  if (mean === 0) return 0;
  return Math.sqrt(Math.max(sumSquares / stats.changedPixels - mean * mean, 0)) / mean;
}

/**
 * Compression, hinting and emoji noise is faint, has no strong pixel, and scatters both ways;
 * a real change is a fill or an edge that moves one way, or it has pixels that are plainly
 * different. Returns why a region is noise, or null when it is not.
 */
function noiseReason(stats: BoxStats, options: RegionOptions): string | null {
  const faint = options.noiseAmplitude ?? DEFAULT_NOISE_AMPLITUDE;
  if (faint <= 0 || stats.changedPixels === 0) return null;
  if (amplitudeSpread(stats) < MIN_AMPLITUDE_SPREAD) return null;
  const mixed = Math.min(stats.lighterPixels, stats.changedPixels - stats.lighterPixels);
  if (mixed / stats.changedPixels < MIN_MIXED_SHARE) return null;
  const limit = faint * 255;
  if (amplitudeAt(stats, 0.9) > limit || amplitudeAt(stats, 1) > limit * 2) return null;
  return "faint, uneven, lighter and darker";
}

/** The merged boxes of the changed pixels, before the speck floor and the noise call. */
function clusterBoxes(field: DiffField, mergeDistance: number): Box[] {
  const boxes = blobBoxes(field, dilatedChanged(field, mergeDistance));
  return mergeBoxes(boxes, mergeDistance);
}

export function findRegions(field: DiffField, options: RegionOptions = {}): RegionResult {
  const gap = options.mergeDistance ?? DEFAULT_MERGE_DISTANCE;
  const minArea = options.minRegionArea ?? DEFAULT_MIN_REGION_AREA;
  const regions: Region[] = [];
  const specks: Specks = { count: 0, pixels: 0 };
  for (const box of clusterBoxes(field, gap)) {
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    const stats = boxStats(field, box);
    if (w * h < minArea) {
      specks.count++;
      specks.pixels += stats.changedPixels;
      continue;
    }
    const why = noiseReason(stats, options);
    const region: Region = {
      x: box.x0,
      y: box.y0,
      w,
      h,
      changedPixels: stats.changedPixels,
      antialiasedPixels: stats.antialiasedPixels,
      kind: why ? "noise" : "change",
    };
    if (why) region.why = why;
    regions.push(region);
  }
  regions.sort((a, b) => b.w * b.h - a.w * a.h);
  return { regions, specks };
}
