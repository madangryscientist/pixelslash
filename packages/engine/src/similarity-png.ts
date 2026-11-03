import { PNG } from "pngjs";
import { readPngSize } from "./identical.ts";
import { release } from "./release.ts";
import { similarity, type Raster } from "./similarity.ts";

/**
 * The similarity hint (PS-298) of two stored PNG shots: each decoded here, one at a time, scored by
 * `similarity` and freed. A shot that is not a PNG, would not decode, or is larger than
 * `MAX_PIXELS` (a decode that size does not fit a Worker) gives null, "no score", never 0.
 */

/** The most pixels one shot may have to be scored (8 MP decodes to 32 MB; a Worker holds two at once). */
export const MAX_PIXELS = 8_000_000;

export type ScaledPng = { png: Uint8Array; scale: number | null };

function decode(png: Uint8Array): (Raster & { free: () => void }) | null {
  const size = readPngSize(png);
  if (!size || size.width * size.height > MAX_PIXELS) return null;
  try {
    const img = PNG.sync.read(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    return { width: img.width, height: img.height, data: img.data, free: () => release(img.data) };
  } catch {
    return null;
  }
}

export function similarityOfPngs(a: ScaledPng, b: ScaledPng): number | null {
  const left = decode(a.png);
  if (!left) return null;
  try {
    const right = decode(b.png);
    if (!right) return null;
    try {
      return similarity({ raster: left, scale: a.scale }, { raster: right, scale: b.scale });
    } finally {
      right.free();
    }
  } finally {
    left.free();
  }
}
