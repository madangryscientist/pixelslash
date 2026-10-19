import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { diffPngs } from "../src/diff.ts";

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const o = i << 2;
    img.data[o] = rgba[0];
    img.data[o + 1] = rgba[1];
    img.data[o + 2] = rgba[2];
    img.data[o + 3] = rgba[3];
  }
  return PNG.sync.write(img);
}

describe("diffPngs", () => {
  test("identical → changedPixels 0", () => {
    const png = solid(4, 2, [10, 20, 30, 255]);
    const d = diffPngs(png, png);
    expect(d.changedPixels).toBe(0);
    expect(d.width).toBe(4);
    expect(d.height).toBe(2);
  });

  test("one pixel differs", () => {
    const a = solid(2, 2, [0, 0, 0, 255]);
    const img = PNG.sync.read(solid(2, 2, [0, 0, 0, 255]));
    img.data[0] = 255;
    const b = PNG.sync.write(img);
    const d = diffPngs(a, b);
    expect(d.changedPixels).toBe(1);
  });

  test("size mismatch diffs the overlap and does not paint the gutter", () => {
    const a = solid(2, 2, [1, 2, 3, 255]);
    const taller = PNG.sync.read(solid(3, 4, [1, 2, 3, 255]));
    taller.data[0] = 9;
    const b = PNG.sync.write(taller);
    const d = diffPngs(a, b);
    expect(d.changedPixels).toBe(1);
    expect(d.mainWidth).toBe(2);
    expect(d.mainHeight).toBe(2);
    expect(d.branchWidth).toBe(3);
    expect(d.branchHeight).toBe(4);
    const overlay = PNG.sync.read(d.overlay);
    expect(overlay.width).toBe(3);
    expect(overlay.height).toBe(4);
    expect(overlay.data[0]).toBe(255);
    expect(overlay.data[3]).toBe(255);
    const gutter = (3 * overlay.width + 2) << 2;
    expect(overlay.data[gutter + 3]).toBe(0);
  });

  test("identical overlap of different sizes → changedPixels 0", () => {
    const a = solid(2, 2, [0, 0, 0, 255]);
    const b = solid(3, 2, [0, 0, 0, 255]);
    const d = diffPngs(a, b);
    expect(d.changedPixels).toBe(0);
    const overlay = PNG.sync.read(d.overlay);
    for (let i = 0; i < overlay.width * overlay.height; i++) {
      expect(overlay.data[(i << 2) + 3]).toBe(0);
    }
  });
});
