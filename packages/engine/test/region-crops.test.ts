import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { REGION_CROP_MAX_SIDE, REGION_CROP_PADDING, regionCrops } from "../src/region-crops.ts";

/** An image whose every pixel encodes its own position, so a crop says where it was cut from. */
function positional(width: number, height: number, tag: number): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = x % 256;
      img.data[i + 1] = y % 256;
      img.data[i + 2] = tag;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

const pixel = (png: Buffer, x: number, y: number) => {
  const img = PNG.sync.read(png);
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

describe("regionCrops", () => {
  test("each crop is its region plus the padding, cut from the same place in all three images", () => {
    const images = {
      main: positional(200, 100, 1),
      branch: positional(200, 100, 2),
      diff: positional(200, 100, 3),
    };
    const [crop] = regionCrops(images, [{ x: 50, y: 40, w: 10, h: 8 }]);
    const pad = REGION_CROP_PADDING;
    expect(crop?.box).toEqual({ x: 50 - pad, y: 40 - pad, w: 10 + 2 * pad, h: 8 + 2 * pad });
    expect(crop?.scale).toBe(1);
    for (const [png, tag] of [
      [crop?.main, 1],
      [crop?.branch, 2],
      [crop?.diff, 3],
    ] as const) {
      if (!png) throw new Error("no crop");
      const img = PNG.sync.read(png);
      expect([img.width, img.height]).toEqual([10 + 2 * pad, 8 + 2 * pad]);
      expect(pixel(png, 0, 0)).toEqual([50 - pad, 40 - pad, tag]);
      expect(pixel(png, pad, pad)).toEqual([50, 40, tag]);
    }
  });

  test("a crop is clipped to the smallest image, so the non-overlap is never sent", () => {
    const images = {
      main: positional(60, 60, 1),
      branch: positional(40, 50, 2),
      diff: positional(60, 60, 3),
    };
    const [crop] = regionCrops(images, [{ x: 30, y: 40, w: 10, h: 10 }]);
    expect(crop?.box).toEqual({
      x: 30 - REGION_CROP_PADDING,
      y: 40 - REGION_CROP_PADDING,
      w: 26,
      h: 26,
    });
  });

  test("a region past the overlap has no crop", () => {
    const images = {
      main: positional(20, 20, 1),
      branch: positional(20, 20, 2),
      diff: positional(20, 20, 3),
    };
    expect(regionCrops(images, [{ x: 50, y: 50, w: 4, h: 4 }])).toEqual([null]);
  });

  test("a region bigger than the cap is shrunk by a whole factor", () => {
    const side = REGION_CROP_MAX_SIDE + 200;
    const images = {
      main: positional(side, 30, 1),
      branch: positional(side, 30, 2),
      diff: positional(side, 30, 3),
    };
    const [crop] = regionCrops(images, [{ x: 0, y: 0, w: side, h: 30 }]);
    expect(crop?.scale).toBe(2);
    const img = PNG.sync.read(crop?.branch ?? Buffer.alloc(0));
    expect(img.width).toBe(side / 2);
    expect(img.width).toBeLessThanOrEqual(REGION_CROP_MAX_SIDE);
  });
});
