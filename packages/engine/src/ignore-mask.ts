import type { IgnoreRect } from "./diff.ts";

/** The ignore rects clipped to a `width` x `height` overlap; empty ones and repeats are dropped. */
export function clipRects(rects: IgnoreRect[], width: number, height: number): IgnoreRect[] {
  const out: IgnoreRect[] = [];
  for (const r of rects) {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const right = Math.min(width, Math.ceil(r.x + r.width));
    const bottom = Math.min(height, Math.ceil(r.y + r.height));
    if (right <= x || bottom <= y) continue;
    const clipped = { x, y, width: right - x, height: bottom - y };
    const seen = out.some(
      (o) => o.x === x && o.y === y && o.width === clipped.width && o.height === clipped.height,
    );
    if (!seen) out.push(clipped);
  }
  return out;
}

/** A per-pixel flag over the overlap, set inside any rect, and how many pixels that is. */
export function ignoreMask(rects: IgnoreRect[], width: number, height: number) {
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height; y++) {
      const row = mask.subarray(y * width + r.x, y * width + r.x + r.width);
      count += row.length - row.reduce((n, flag) => n + flag, 0);
      row.fill(1);
    }
  }
  return { mask, count };
}
