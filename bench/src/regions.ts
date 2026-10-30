/**
 * Turn a changed-pixel mask into boxes and score them against a ground-truth box (ob 1477).
 * PixelSlash and Argos both hand us a mask image, not a region list, so both go through this one
 * extractor: the comparison of where they point is then about the masks, not about our clustering.
 */
export type Rect = { x: number; y: number; w: number; h: number };

/** Changed pixels closer than this (in either axis) belong to the same region. */
export const MERGE_GAP = 8;

export type Mask = { width: number; height: number; changed: Uint8Array };

/** A mask from RGBA pixels: any pixel with alpha > 0 is changed (both tools paint on transparency). */
export function maskFromRgba(width: number, height: number, rgba: Uint8Array): Mask {
  const changed = new Uint8Array(width * height);
  for (let i = 0; i < changed.length; i++) changed[i] = (rgba[(i << 2) + 3] ?? 0) > 0 ? 1 : 0;
  return { width, height, changed };
}

export function countChanged(mask: Mask): number {
  let n = 0;
  for (const v of mask.changed) n += v;
  return n;
}

type Axis = { lines: number; len: number; lineStride: number; stride: number };

/** One pass of a separable dilation: every cell within `gap` of a changed one, along one axis. */
function dilateAxis(src: Uint8Array, axis: Axis, gap: number) {
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

/** Dilate by `gap` in x then y (a square structuring element), so near pixels become one blob. */
function dilate(mask: Mask, gap: number): Uint8Array {
  const { width, height, changed } = mask;
  const wide = dilateAxis(
    changed,
    { lines: height, len: width, lineStride: width, stride: 1 },
    gap,
  );
  return dilateAxis(wide, { lines: width, len: height, lineStride: 1, stride: width }, gap);
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Indexes of the in-bounds 8-neighbours of cell `at`. */
function* neighbours(at: number, width: number, height: number): Generator<number> {
  const x = at % width;
  const y = (at - x) / width;
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < width && ny < height) yield ny * width + nx;
  }
}

/** Flood one blob from `start`, marking it in `seen`; returns the box of its changed pixels. */
function floodBlob(mask: Mask, blob: Uint8Array, seen: Uint8Array, start: number): Rect | null {
  const { width, height, changed } = mask;
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const at = stack.pop() ?? 0;
    if (changed[at]) {
      const x = at % width;
      const y = (at - x) / width;
      box = box
        ? {
            x0: Math.min(box.x0, x),
            y0: Math.min(box.y0, y),
            x1: Math.max(box.x1, x),
            y1: Math.max(box.y1, y),
          }
        : { x0: x, y0: y, x1: x, y1: y };
    }
    for (const next of neighbours(at, width, height)) {
      if (!blob[next] || seen[next]) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return box && { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 };
}

/** Bounding boxes of the changed pixels, one per blob of the dilated mask, largest first. */
export function extractRegions(mask: Mask, gap = MERGE_GAP): Rect[] {
  const blob = dilate(mask, gap);
  const seen = new Uint8Array(blob.length);
  const regions: Rect[] = [];
  for (let start = 0; start < blob.length; start++) {
    if (!blob[start] || seen[start]) continue;
    const region = floodBlob(mask, blob, seen, start);
    if (region) regions.push(region);
  }
  return regions.toSorted((a, b) => b.w * b.h - a.w * a.h);
}

export function area(r: Rect): number {
  return r.w * r.h;
}

/**
 * Pixel IoU between the union of `regions` and the ground-truth `box`. 1 is an exact match; a tool
 * that paints the box and also a stray region elsewhere loses on the union, and one that misses part
 * of the box loses on the intersection. No regions is 0.
 */
export function iou(regions: Rect[], box: Rect, width: number, height: number): number {
  const w = Math.max(width, box.x + box.w, ...regions.map((r) => r.x + r.w));
  const h = Math.max(height, box.y + box.h, ...regions.map((r) => r.y + r.h));
  const covered = new Uint8Array(w * h);
  for (const r of regions) {
    for (let y = r.y; y < r.y + r.h; y++) covered.fill(1, y * w + r.x, y * w + r.x + r.w);
  }
  let inter = 0;
  let union = 0;
  const inBox = (x: number, y: number) =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = covered[y * w + x] === 1;
      const b = inBox(x, y);
      if (c && b) inter++;
      if (c || b) union++;
    }
  }
  return union === 0 ? 0 : inter / union;
}
