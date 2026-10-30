import { describe, expect, test, vi } from "vitest";
import { PNG } from "pngjs";
import { diffPngs, measurePngs } from "../src/diff.ts";

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

/** The same pixels, encoded another way: a different file, so no shortcut. */
function reencoded(png: Buffer): Buffer {
  return PNG.sync.write(PNG.sync.read(png), { deflateLevel: 1, filterType: 0 });
}

describe("diffPngs, identical bytes (ob 1948)", () => {
  test("byte-equal PNGs are unchanged without a decode, a diff or an overlay", () => {
    const png = solid(4, 2, [10, 20, 30, 255]);
    const read = vi.spyOn(PNG.sync, "read");
    const d = diffPngs(png, Buffer.from(png));
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(d.settledBy).toBe("identical-bytes");
    expect(d.changed).toBe(false);
    expect(d.changedPixels).toBe(0);
    expect(d.regions).toEqual([]);
    expect(d.overlay).toBeNull();
    expect([d.mainWidth, d.mainHeight, d.branchWidth, d.branchHeight]).toEqual([4, 2, 4, 2]);
    expect([d.width, d.height]).toEqual([4, 2]);
  });

  test("options and ignore areas cannot change the verdict", () => {
    const png = solid(4, 4, [1, 2, 3, 255]);
    const area = { x: 0, y: 0, width: 2, height: 2 };
    const d = diffPngs(
      png,
      Buffer.from(png),
      { threshold: 0, minChangedPixels: 1, minRegionArea: 1 },
      { main: [area], branch: [area] },
    );
    expect(d.settledBy).toBe("identical-bytes");
    expect(d.changed).toBe(false);
  });

  test("a changed pixel takes the measured path and keeps its overlay", () => {
    const a = solid(3, 3, [5, 5, 5, 255]);
    const flipped = PNG.sync.read(a);
    flipped.data[0] = 200;
    const changed = diffPngs(a, PNG.sync.write(flipped), { minRegionArea: 1 });
    expect(changed.settledBy).toBe("measured");
    expect(changed.changed).toBe(true);
    expect(changed.overlay).not.toBeNull();
  });

  test("differently encoded PNGs with the same pixels are measured, and come out unchanged", () => {
    const a = edge(128);
    const b = reencoded(a);
    expect(b.equals(a)).toBe(false);
    const d = diffPngs(a, b);
    expect(d.settledBy).toBe("measured");
    expect(d.changed).toBe(false);
    expect(d.changedPixels).toBe(0);
    expect(d.overlay).not.toBeNull();
  });

  test("identical bytes that are not a PNG are refused as before", () => {
    const junk = Buffer.from("not a png at all, but long enough to have an IHDR-sized header");
    expect(() => diffPngs(junk, Buffer.from(junk))).toThrow("unrecognised content");
  });
});

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
    const d = measurePngs(a, b);
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
    const d = measurePngs(a, b);
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

describe("diffPngs ignore areas", () => {
  /** 20x20 white, with a black `size` square at (x, y). */
  function square(x: number, y: number, size: number): Buffer {
    const img = PNG.sync.read(solid(20, 20, [255, 255, 255, 255]));
    for (let j = y; j < y + size; j++) {
      for (let i = x; i < x + size; i++) {
        const o = (j * 20 + i) << 2;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
      }
    }
    return PNG.sync.write(img);
  }
  const blank = solid(20, 20, [255, 255, 255, 255]);
  const opts = { minRegionArea: 1 };

  test("no ignore areas: ignoredPixels 0", () => {
    const d = diffPngs(blank, square(4, 4, 4), opts);
    expect(d.ignoredPixels).toBe(0);
    expect(d.ignored).toEqual([]);
    expect(d.changed).toBe(true);
  });

  test("a change fully inside an ignore box → unchanged, with ignoredPixels counted", () => {
    const box = { x: 2, y: 2, width: 10, height: 10 };
    const d = diffPngs(blank, square(4, 4, 4), opts, { branch: [box] });
    expect(d.changed).toBe(false);
    expect(d.changedPixels).toBe(0);
    expect(d.regions).toEqual([]);
    expect(d.specks).toEqual({ count: 0, pixels: 0 });
    expect(d.ignoredPixels).toBe(100);
    expect(d.ignored).toEqual([box]);
  });

  test("a change half outside the box → changed, the region clipped to the outside part", () => {
    // 4x4 square at x 4..7; the box covers x 0..5, so columns 6 and 7 remain.
    const d = diffPngs(blank, square(4, 4, 4), opts, {
      main: [{ x: 0, y: 0, width: 6, height: 20 }],
    });
    expect(d.changed).toBe(true);
    expect(d.changedPixels).toBe(8);
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0]).toMatchObject({ x: 6, y: 4, w: 2, h: 4, changedPixels: 8 });
    expect(d.ignoredPixels).toBe(120);
  });

  test("the union of the baseline and the branch boxes: an element that moved", () => {
    // Black square at (2,2) in main, (12,12) in branch; each box covers one place.
    const d = diffPngs(square(2, 2, 4), square(12, 12, 4), opts, {
      main: [{ x: 2, y: 2, width: 4, height: 4 }],
      branch: [{ x: 12, y: 12, width: 4, height: 4 }],
    });
    expect(d.changed).toBe(false);
    expect(d.changedPixels).toBe(0);
    expect(d.ignoredPixels).toBe(32);
    // Only one box: the other place is still measured and still changed.
    const half = diffPngs(square(2, 2, 4), square(12, 12, 4), opts, {
      main: [{ x: 2, y: 2, width: 4, height: 4 }],
    });
    expect(half.changed).toBe(true);
    expect(half.changedPixels).toBe(16);
  });

  test("overlapping boxes are counted once; boxes past the overlap are clipped away", () => {
    const d = measurePngs(blank, blank, opts, {
      main: [{ x: 0, y: 0, width: 10, height: 10 }],
      branch: [
        { x: 5, y: 5, width: 10, height: 10 },
        { x: 40, y: 40, width: 5, height: 5 },
        { x: 15, y: 15, width: 100, height: 100 },
      ],
    });
    expect(d.ignoredPixels).toBe(100 + 100 - 25 + 25);
    expect(d.ignored).toContainEqual({ x: 15, y: 15, width: 5, height: 5 });
    expect(d.ignored).toHaveLength(3);
  });

  test("the same box on both shots is listed once", () => {
    const box = { x: 2, y: 2, width: 10, height: 10 };
    const d = measurePngs(blank, blank, opts, { main: [box], branch: [box] });
    expect(d.ignored).toEqual([box]);
    expect(d.ignoredPixels).toBe(100);
  });

  test("the ratio floor counts only measured pixels", () => {
    // 16 changed of 400 px is 4%; with 200 ignored it is 8% of the 200 measured.
    const left = { x: 0, y: 0, width: 10, height: 20 };
    const sq = square(14, 4, 4);
    expect(diffPngs(blank, sq, { ...opts, minChangedRatio: 0.06 }).changed).toBe(false);
    expect(diffPngs(blank, sq, { ...opts, minChangedRatio: 0.06 }, { main: [left] }).changed).toBe(
      true,
    );
  });
});
