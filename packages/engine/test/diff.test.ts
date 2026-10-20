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

/** Black on the left, white on the right, a grey edge column; one edge pixel (row 4) is `grey`. */
function edge(grey: number): Buffer {
  const img = new PNG({ width: 8, height: 8 });
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let v = 255;
      if (x < 3) v = 0;
      else if (x === 3) v = y === 4 ? grey : 128;
      const o = (y * 8 + x) << 2;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

describe("diffPngs", () => {
  test("identical → changedPixels 0", () => {
    const png = solid(4, 2, [10, 20, 30, 255]);
    const d = diffPngs(png, png);
    expect(d.changedPixels).toBe(0);
    expect(d.changed).toBe(false);
    expect(d.antialiased).toBe(0);
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
    expect(d.changed).toBe(false);
    expect(d.specks).toEqual({ count: 1, pixels: 1 });
    expect(diffPngs(a, b, { minRegionArea: 1 }).changed).toBe(true);
  });

  test("size mismatch diffs the overlap and does not paint the gutter", () => {
    const a = solid(2, 2, [1, 2, 3, 255]);
    const taller = PNG.sync.read(solid(3, 4, [1, 2, 3, 255]));
    taller.data[0] = 9;
    const b = PNG.sync.write(taller);
    const d = diffPngs(a, b);
    expect(d.changedPixels).toBe(1);
    expect(d.changed).toBe(true);
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

  test("identical overlap of different sizes → changedPixels 0, but the sizes differ so changed", () => {
    const a = solid(2, 2, [0, 0, 0, 255]);
    const b = solid(3, 2, [0, 0, 0, 255]);
    const d = diffPngs(a, b);
    expect(d.changedPixels).toBe(0);
    expect(d.changed).toBe(true);
    const overlay = PNG.sync.read(d.overlay);
    for (let i = 0; i < overlay.width * overlay.height; i++) {
      expect(overlay.data[(i << 2) + 3]).toBe(0);
    }
  });

  test("a 1px colour change of a few levels still flags at default settings", () => {
    const a = solid(9, 9, [200, 200, 200, 255]);
    const img = PNG.sync.read(solid(9, 9, [200, 200, 200, 255]));
    const at = (4 * 9 + 4) << 2;
    img.data[at] = 190;
    img.data[at + 1] = 190;
    img.data[at + 2] = 190;
    const d = diffPngs(a, PNG.sync.write(img), { minRegionArea: 1 });
    expect(d.changed).toBe(true);
    expect(d.changedPixels).toBe(1);
    expect(d.antialiased).toBe(0);
  });

  test("a difference below the threshold is not changed; threshold 0 sees it", () => {
    const a = solid(9, 9, [200, 200, 200, 255]);
    const img = PNG.sync.read(solid(9, 9, [200, 200, 200, 255]));
    img.data[(4 * 9 + 4) << 2] = 201;
    const b = PNG.sync.write(img);
    expect(diffPngs(a, b, { minRegionArea: 1 }).changed).toBe(false);
    expect(diffPngs(a, b, { threshold: 0, minRegionArea: 1 }).changed).toBe(true);
  });

  test("alpha is blended over white before comparing", () => {
    const a = solid(5, 5, [0, 0, 0, 0]);
    const b = solid(5, 5, [255, 255, 255, 255]);
    expect(diffPngs(a, b).changed).toBe(false);
    expect(diffPngs(a, solid(5, 5, [0, 0, 0, 255])).changed).toBe(true);
  });

  test("a pure anti-aliased edge difference is set aside, not counted as changed", () => {
    // Branch shades one edge pixel a different grey.
    const d = diffPngs(edge(128), edge(100));
    expect(d.changedPixels).toBe(0);
    expect(d.antialiased).toBe(1);
    expect(d.changed).toBe(false);
  });

  test("a flat-area pixel flip is not anti-aliasing", () => {
    const a = solid(9, 9, [255, 255, 255, 255]);
    const img = PNG.sync.read(solid(9, 9, [255, 255, 255, 255]));
    const at = (4 * 9 + 4) << 2;
    img.data[at] = img.data[at + 1] = img.data[at + 2] = 0;
    const d = diffPngs(a, PNG.sync.write(img));
    expect(d.changedPixels).toBe(1);
    expect(d.antialiased).toBe(0);
  });

  test("floors turn a small change into not-changed without hiding the count", () => {
    const a = solid(10, 10, [0, 0, 0, 255]);
    const img = PNG.sync.read(solid(10, 10, [0, 0, 0, 255]));
    for (let i = 0; i < 3; i++) img.data[i << 2] = 255;
    const b = PNG.sync.write(img);
    expect(diffPngs(a, b, { minChangedPixels: 4, minRegionArea: 1 })).toMatchObject({
      changed: false,
      changedPixels: 3,
    });
    expect(diffPngs(a, b, { minChangedRatio: 0.05, minRegionArea: 1 })).toMatchObject({
      changed: false,
    });
    expect(
      diffPngs(a, b, { minChangedPixels: 3, minChangedRatio: 0.03, minRegionArea: 1 }).changed,
    ).toBe(true);
  });

  test("a size mismatch is changed even past the floors", () => {
    const d = diffPngs(solid(2, 2, [0, 0, 0, 255]), solid(2, 3, [0, 0, 0, 255]), {
      minChangedPixels: 100,
    });
    expect(d.changed).toBe(true);
    expect(d.branchHeight).toBe(3);
  });
});
