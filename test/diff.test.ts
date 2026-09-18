import { describe, expect, test } from "bun:test";
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

  test("size mismatch → whole frame is a change", () => {
    const a = solid(2, 2, [0, 0, 0, 255]);
    const b = solid(3, 2, [0, 0, 0, 255]);
    const d = diffPngs(a, b);
    expect(d.changedPixels).toBe(3 * 2);
    expect(d.width).toBe(3);
    expect(d.height).toBe(2);
  });
});
