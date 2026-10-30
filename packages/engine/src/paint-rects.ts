import { PNG } from "pngjs";
import type { MaskRect } from "./config.ts";

const MASK_RGBA = [255, 0, 255, 255] as const;

/** Paint each rectangle (CSS px, scaled by `scale` to image px, clipped to the image) in MASK_COLOR. */
export function paintRects(png: Buffer, rects: MaskRect[], scale: number): Buffer {
  if (rects.length === 0) return png;
  const img = PNG.sync.read(png);
  for (const r of rects) {
    const x1 = Math.min(img.width, (r.x + r.width) * scale);
    const y1 = Math.min(img.height, (r.y + r.height) * scale);
    for (let y = r.y * scale; y < y1; y++) {
      for (let x = r.x * scale; x < x1; x++) img.data.set(MASK_RGBA, (y * img.width + x) << 2);
    }
  }
  return PNG.sync.write(img);
}
