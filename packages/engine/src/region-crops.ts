import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { readPngSize } from "./identical.ts";
import { release } from "./release.ts";

/** A box in image px, from the top-left of the shots: a diff region, or the crop around one. */
export type Box = { x: number; y: number; w: number; h: number };

/** Context around a region, so the model sees what the change sits in. */
export const REGION_CROP_PADDING = 16;

/** A crop's longer side is brought down to this, so a page-sized region is not a page-sized upload. */
export const REGION_CROP_MAX_SIDE = 1024;

/** One region's three crops, all of the same `box`, as encoded PNGs. */
export type RegionCrop = {
  /** The padded box that was cut, clipped to the images; `scale` is how much it was shrunk. */
  box: Box;
  scale: number;
  main: Buffer;
  branch: Buffer;
  diff: Buffer;
};

/** The padded region, clipped to `width`×`height`; null when nothing of it is left. */
export function cropBox(region: Box, width: number, height: number): Box | null {
  const x = Math.max(0, region.x - REGION_CROP_PADDING);
  const y = Math.max(0, region.y - REGION_CROP_PADDING);
  const right = Math.min(width, region.x + region.w + REGION_CROP_PADDING);
  const bottom = Math.min(height, region.y + region.h + REGION_CROP_PADDING);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/** Cut `box` out of `img`, keeping every `scale`th pixel (nearest neighbour: no blur to read as change). */
function cut(img: PNG, box: Box, scale: number): Buffer {
  const out = new PNG({ width: Math.ceil(box.w / scale), height: Math.ceil(box.h / scale) });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = ((box.y + y * scale) * img.width + box.x + x * scale) * 4;
      img.data.copy(out.data, (y * out.width + x) * 4, from, from + 4);
    }
  }
  return PNG.sync.write(out);
}

/** A PNG's size from its header, before any of it is decoded. */
function sizeOf(png: Buffer, name: string): { width: number; height: number } {
  const size = readPngSize(png);
  if (!size) throw new Error(`the ${name} image is not a PNG`);
  return size;
}

/** Each box cut from one image, decoded here and freed before the next image is (PS-206). */
function cutAll(png: Buffer, boxes: ({ box: Box; scale: number } | null)[]): (Buffer | null)[] {
  const img = PNG.sync.read(png);
  try {
    return boxes.map((at) => at && cut(img, at.box, at.scale));
  } finally {
    // A full-page raster (~49 MB at 1280x9500), dead now. A Worker has no gc(): left to the
    // collector, a burst of explained shots held workerd at 1.5 GB (PS-206, as PS-200).
    release(img.data);
  }
}

/**
 * The baseline, new and diff-overlay crops of each region (ob 1473), and nothing else of the shots.
 * Regions are in the overlap's px, so every crop is clipped to the smallest of the three images:
 * the non-overlap is never sent as if it were part of the change. Each PNG is decoded once, and
 * one at a time: its crops are cut and its pixels freed before the next is decoded.
 */
export function regionCrops(
  images: { main: Buffer; branch: Buffer; diff: Buffer },
  regions: Box[],
): (RegionCrop | null)[] {
  const sizes = [
    sizeOf(images.main, "baseline"),
    sizeOf(images.branch, "new"),
    sizeOf(images.diff, "diff"),
  ];
  const width = Math.min(...sizes.map((s) => s.width));
  const height = Math.min(...sizes.map((s) => s.height));
  const boxes = regions.map((region) => {
    const box = cropBox(region, width, height);
    if (!box) return null;
    return { box, scale: Math.ceil(Math.max(box.w, box.h) / REGION_CROP_MAX_SIDE) };
  });
  const main = cutAll(images.main, boxes);
  const branch = cutAll(images.branch, boxes);
  const diff = cutAll(images.diff, boxes);
  return boxes.map((at, i) => {
    const [m, b, d] = [main[i], branch[i], diff[i]];
    return at && m && b && d ? { ...at, main: m, branch: b, diff: d } : null;
  });
}
