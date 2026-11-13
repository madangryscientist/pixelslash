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

/** The grey at (x, y): `rects` painted over white, each taking the share of the pixel it covers. */
function shade(rects: SoftRect[], x: number, y: number): number {
  let v = 255;
  for (const [rx, ry, rw, rh, grey] of rects) {
    const c = cover(rx, rw, x) * cover(ry, rh, y);
    if (c > 0) v = v * (1 - c) + grey * c;
  }
  return Math.round(v);
}

export function softPage(width: number, height: number, rects: SoftRect[]): PNG {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = shade(rects, x, y);
      img.data.set([v, v, v, 255], (y * width + x) << 2);
    }
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
