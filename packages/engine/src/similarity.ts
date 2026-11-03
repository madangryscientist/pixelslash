/**
 * A perceptual-similarity hint between two decoded shots (PS-298), for the parity view: how alike a
 * native shot and its web twin look, once both are at the same physical size. Pure: two decoded
 * RGBA rasters and their scales in, a score in [0, 1] or null out. It is a hint and nothing else:
 * no status, exit code, check or count reads it, and it paints no pixel as changed.
 *
 * How: each raster is reduced to a grid of cells one `cell` of logical pixels wide (its pixels
 * divided by its scale, box-averaged), over the rectangle both cover from the top-left. That
 * cancels the scale (a 3x shot and a 1x shot of the same screen land on the same grid) and blurs
 * glyph edges, which differ between platforms by design. The grids are compared with the
 * structural similarity index (Wang et al. 2004) per colour channel, over 8x8-cell windows.
 */

export type Raster = {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows top to bottom. */
  data: ArrayLike<number>;
};

/** A decoded shot and the device pixel ratio it was taken at; null reads as 1. */
export type ScaledRaster = { raster: Raster; scale: number | null };

/** The longest side of the comparison grid, in cells. */
const MAX_GRID = 384;
const WINDOW = 8;
const STRIDE = 4;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const CHANNELS = 3;

const scaleOf = (s: number | null): number => (s !== null && Number.isFinite(s) && s > 0 ? s : 1);

function valid(r: Raster): boolean {
  return r.width > 0 && r.height > 0 && r.data.length >= r.width * r.height * 4;
}

type Grid = { cols: number; rows: number; cells: Float64Array };

/** The rectangle both shots cover, in logical pixels, from the top-left; null when it is empty. */
function overlap(a: ScaledRaster, b: ScaledRaster): { width: number; height: number } | null {
  const width = Math.min(a.raster.width / scaleOf(a.scale), b.raster.width / scaleOf(b.scale));
  const height = Math.min(a.raster.height / scaleOf(a.scale), b.raster.height / scaleOf(b.scale));
  return width >= 1 && height >= 1 ? { width, height } : null;
}

type Span = { x0: number; x1: number; y0: number; y1: number };

/** The mean colour of the pixels in the half-open span, over white, per channel; white when empty. */
function meanColour(r: Raster, span: Span): number[] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = span.y0; y < Math.min(span.y1, r.height); y++)
    for (let x = span.x0; x < Math.min(span.x1, r.width); x++) {
      const i = (y * r.width + x) * 4;
      const alpha = (r.data[i + 3] ?? 255) / 255;
      for (let c = 0; c < CHANNELS; c++)
        sum[c] = (sum[c] ?? 0) + (r.data[i + c] ?? 0) * alpha + 255 * (1 - alpha);
      n++;
    }
  return sum.map((v) => (n === 0 ? 255 : v / n));
}

/** The mean colour of each `cell`-logical-pixel square of the raster's top-left `cols` x `rows` cells, over white. */
function reduce(s: ScaledRaster, cell: number, cols: number, rows: number): Grid {
  const { raster } = s;
  const step = cell * scaleOf(s.scale);
  const cells = new Float64Array(cols * rows * CHANNELS);
  const edge = (i: number, limit: number) => Math.min(limit, Math.round(i * step));
  for (let gy = 0; gy < rows; gy++) {
    const y0 = edge(gy, raster.height);
    const y1 = Math.max(y0 + 1, edge(gy + 1, raster.height));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = edge(gx, raster.width);
      const x1 = Math.max(x0 + 1, edge(gx + 1, raster.width));
      cells.set(meanColour(raster, { x0, x1, y0, y1 }), (gy * cols + gx) * CHANNELS);
    }
  }
  return { cols, rows, cells };
}

type Window = { x: number; y: number; w: number; h: number };

/** The SSIM of one window of one channel. */
function windowSsim(a: Grid, b: Grid, win: Window, c: number) {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let j = win.y; j < win.y + win.h; j++)
    for (let i = win.x; i < win.x + win.w; i++) {
      const at = (j * a.cols + i) * CHANNELS + c;
      const [va, vb] = [a.cells[at] ?? 0, b.cells[at] ?? 0];
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  const n = win.w * win.h;
  const [ma, mb] = [sa / n, sb / n];
  const [va, vb, cov] = [saa / n - ma * ma, sbb / n - mb * mb, sab / n - ma * mb];
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

function starts(length: number, size: number): number[] {
  const out: number[] = [];
  for (let at = 0; at + size <= length; at += STRIDE) out.push(at);
  const last = length - size;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * How alike two shots look, from 0 (nothing alike) to 1 (the same), to two decimals; null when the
 * pair cannot be scored: a raster that is empty or short of bytes, or no overlap of at least one
 * logical pixel each way. Each shot is read at its own scale, so the same screen shot at 1x and 3x
 * scores 1. Symmetric in its two arguments.
 */
export function similarity(a: ScaledRaster, b: ScaledRaster): number | null {
  if (!valid(a.raster) || !valid(b.raster)) return null;
  const shared = overlap(a, b);
  if (!shared) return null;
  const cell = Math.max(1, Math.ceil(Math.max(shared.width, shared.height) / MAX_GRID));
  const cols = Math.max(1, Math.floor(shared.width / cell));
  const rows = Math.max(1, Math.floor(shared.height / cell));
  const [ga, gb] = [reduce(a, cell, cols, rows), reduce(b, cell, cols, rows)];
  const w = Math.min(WINDOW, cols);
  const h = Math.min(WINDOW, rows);
  let total = 0;
  let count = 0;
  for (const y of starts(rows, h))
    for (const x of starts(cols, w))
      for (let c = 0; c < CHANNELS; c++) {
        total += windowSsim(ga, gb, { x, y, w, h }, c);
        count++;
      }
  const score = Math.min(1, Math.max(0, total / count));
  return Math.round(score * 100) / 100;
}
