import { PNG } from "pngjs";

/**
 * A page with each `[x, y, w, h, grey]` rectangle painted at its fractional position, an edge
 * pixel taking the share of itself the rectangle covers (what a rasteriser does at a sub-pixel offset).
 */
export type SoftRect = [number, number, number, number, number];

/** The share of pixel `px` a span `[lo, lo + len)` covers. */
function cover(lo: number, len: number, px: number): number {
  return Math.max(0, Math.min(lo + len, px + 1) - Math.max(lo, px));
}

/** Paint one rectangle into `grey` (row-major, `width` wide), visiting only the pixels it can touch. */
function paint(grey: Float64Array, width: number, height: number, rect: SoftRect): void {
  const [rx, ry, rw, rh, g] = rect;
  const x0 = Math.max(0, Math.floor(rx));
  const x1 = Math.min(width, Math.ceil(rx + rw));
  const y1 = Math.min(height, Math.ceil(ry + rh));
  for (let y = Math.max(0, Math.floor(ry)); y < y1; y++) {
    const cy = cover(ry, rh, y);
    for (let x = x0; x < x1; x++) {
      const c = cover(rx, rw, x) * cy;
      const i = y * width + x;
      if (c > 0) grey[i] = (grey[i] ?? 255) * (1 - c) + g * c;
    }
  }
}

/**
 * `rects` painted over white, in order, each pixel taking the share of itself a rectangle covers.
 * Each rectangle visits only the pixels it can touch. Scanning every rectangle at every pixel cost
 * about 50 ms a page on an idle desktop, and the size-mismatch test paints twelve, which under the
 * full parallel test run was nearly all of its time and pushed it past the 5 s limit on CI.
 */
export function softPage(width: number, height: number, rects: SoftRect[]): PNG {
  const grey = new Float64Array(width * height).fill(255);
  for (const rect of rects) paint(grey, width, height, rect);
  const img = new PNG({ width, height });
  for (let i = 0; i < grey.length; i++) {
    const v = Math.round(grey[i] ?? 255);
    const at = i << 2;
    img.data[at] = v;
    img.data[at + 1] = v;
    img.data[at + 2] = v;
    img.data[at + 3] = 255;
  }
  return img;
}

/** Strokes in rows, like lines of text: 2px-wide, 10px-tall glyphs at uneven gaps. */
export function textBlock(
  left: number,
  top: number,
  dx = 0,
  dy = 0,
): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  for (let row = 0; row < 4; row++) {
    let x = left;
    for (let g = 0; g < 14; g++) {
      out.push([x + dx, top + row * 18 + dy, 2, 10, 20]);
      if (g % 3 === 0) out.push([x + 4 + dx, top + row * 18 + 4 + dy, 5, 2, 20]);
      x += 7 + (g % 4);
    }
  }
  return out;
}

/** A page with one text block, shifted `dx` pixels right. */
export const shiftedText = (dx: number) => softPage(300, 120, textBlock(20, 20, dx));
