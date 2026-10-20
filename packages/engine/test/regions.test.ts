import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { diffPngs } from "../src/diff.ts";

type Rgba = [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];

/** A page: `bg`, then each `[x, y, w, h, colour]` rectangle painted over it. */
function page(
  width: number,
  height: number,
  rects: Array<[number, number, number, number, Rgba]> = [],
  bg: Rgba = WHITE,
): PNG {
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) img.data.set(bg, i << 2);
  for (const [x, y, w, h, colour] of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) img.data.set(colour, (yy * width + xx) << 2);
    }
  }
  return img;
}

const png = (img: PNG) => PNG.sync.write(img);

/**
 * A page with each `[x, y, w, h, grey]` rectangle painted at its fractional position, an edge
 * pixel taking the share of itself the rectangle covers (what a rasteriser does at a sub-pixel offset).
 */
type SoftRect = [number, number, number, number, number];

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

function softPage(width: number, height: number, rects: SoftRect[]): PNG {
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
function textBlock(
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
const shiftedText = (dx: number) => softPage(300, 120, textBlock(20, 20, dx));

/** Two buttons side by side, the second moved `second` pixels away, with a line of text below. */
const buttons = (second: number): SoftRect[] => [
  [20, 20, 60, 24, 60],
  [84 + second, 20, 60, 24, 60],
  ...textBlock(20, 60),
];

/** Four lines of text, the second moved `second` pixels right against the ones around it. */
const shiftedLine = (second: number) =>
  textBlock(20, 10).map(([x, y, w, h, grey]): SoftRect =>
    y >= 28 && y < 46 ? [x + second, y, w, h, grey] : [x, y, w, h, grey],
  );

const RED: Rgba = [220, 30, 30, 255];
const BLUE: Rgba = [30, 30, 220, 255];
const BLACK: Rgba = [0, 0, 0, 255];

/** Deterministic pseudo-random grey flecks, half up and half down, `step` grey levels each. */
function fleck(img: PNG, box: { x: number; y: number; w: number; h: number }, step: number) {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const r = next();
      if (r > 0.3) continue;
      const delta = 3 + Math.floor(next() * step);
      const v = r < 0.15 ? 200 + delta : 200 - delta;
      img.data.set([v, v, v, 255], (y * img.width + x) << 2);
    }
  }
}

describe("regions", () => {
  test("two separate changes → two regions, each with its own box", () => {
    const main = page(300, 100);
    const branch = page(300, 100, [
      [10, 10, 20, 20, RED],
      [200, 60, 30, 15, BLUE],
    ]);
    const d = diffPngs(png(main), png(branch));
    expect(d.changed).toBe(true);
    expect(d.regions).toHaveLength(2);
    const [first, second] = d.regions;
    expect(first).toMatchObject({
      x: 200,
      y: 60,
      w: 30,
      h: 15,
      changedPixels: 450,
      kind: "change",
    });
    expect(second).toMatchObject({
      x: 10,
      y: 10,
      w: 20,
      h: 20,
      changedPixels: 400,
      kind: "change",
    });
    expect(d.specks).toEqual({ count: 0, pixels: 0 });
  });

  test("a ring of changes around a moved element → one region", () => {
    const main = page(300, 300, [[140, 140, 20, 20, BLACK]]);
    const branch = page(300, 300, [
      [20, 20, 260, 4, RED],
      [20, 276, 260, 4, RED],
      [20, 24, 4, 252, RED],
      [276, 24, 4, 252, RED],
      [170, 140, 20, 20, BLACK],
    ]);
    const d = diffPngs(png(main), png(branch), { mergeDistance: 8 });
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0]).toMatchObject({ x: 20, y: 20, w: 260, h: 260 });
  });

  test("changes closer than the merge distance are one region, farther ones are two", () => {
    const main = page(200, 50);
    const branch = page(200, 50, [
      [10, 10, 10, 10, RED],
      [40, 10, 10, 10, RED],
    ]);
    expect(diffPngs(png(main), png(branch), { mergeDistance: 24 }).regions).toHaveLength(1);
    expect(diffPngs(png(main), png(branch), { mergeDistance: 8 }).regions).toHaveLength(2);
  });

  test("a speck below the minimum area does not make the run changed, but is counted", () => {
    const main = page(100, 100);
    const branch = page(100, 100, [[50, 50, 1, 3, BLACK]]);
    const d = diffPngs(png(main), png(branch));
    expect(d.changedPixels).toBe(3);
    expect(d.regions).toEqual([]);
    expect(d.specks).toEqual({ count: 1, pixels: 3 });
    expect(d.changed).toBe(false);
  });

  test("minRegionArea is an option: a smaller floor keeps the same speck as a region", () => {
    const main = page(100, 100);
    const branch = page(100, 100, [[50, 50, 1, 3, BLACK]]);
    const d = diffPngs(png(main), png(branch), { minRegionArea: 1 });
    expect(d.regions).toHaveLength(1);
    expect(d.specks.count).toBe(0);
    expect(d.changed).toBe(true);
  });

  test("scattered faint flecks that go both ways are noise: kept, labelled, not changed", () => {
    const main = page(200, 100, [], [200, 200, 200, 255]);
    const branch = page(200, 100, [], [200, 200, 200, 255]);
    fleck(branch, { x: 20, y: 20, w: 120, h: 60 }, 10);
    const d = diffPngs(png(main), png(branch));
    expect(d.changedPixels).toBeGreaterThan(500);
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0]?.kind).toBe("noise");
    expect(d.regions[0]?.why).toMatch(/faint/);
    expect(d.changed).toBe(false);
  });

  test("a low-contrast bar that moves is a real change: one colour delta is not noise", () => {
    const grey: Rgba = [229, 231, 235, 255];
    const main = page(200, 40, [[10, 10, 180, 1, grey]]);
    const branch = page(200, 40, [[10, 12, 180, 1, grey]]);
    const d = diffPngs(png(main), png(branch));
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0]?.kind).toBe("change");
    expect(d.changed).toBe(true);
  });

  test("a faint change that moves one way is a real tint, not noise", () => {
    const main = page(200, 100, [[20, 20, 120, 60, [200, 200, 200, 255]]]);
    const branch = page(200, 100, [[20, 20, 120, 60, [206, 206, 206, 255]]]);
    const d = diffPngs(png(main), png(branch));
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0]).toMatchObject({ kind: "change", w: 120, h: 60 });
    expect(d.changed).toBe(true);
  });

  test("noise next to a real change: the run is changed, the noise region stays noise", () => {
    const main = page(400, 100, [], [200, 200, 200, 255]);
    const branch = page(400, 100, [[300, 30, 30, 30, BLACK]], [200, 200, 200, 255]);
    fleck(branch, { x: 20, y: 20, w: 120, h: 60 }, 10);
    const d = diffPngs(png(main), png(branch));
    expect(d.regions.map((r) => r.kind).toSorted()).toEqual(["change", "noise"]);
    expect(d.changed).toBe(true);
  });

  test("noiseAmplitude 0 turns the noise call off", () => {
    const main = page(200, 100, [], [200, 200, 200, 255]);
    const branch = page(200, 100, [], [200, 200, 200, 255]);
    fleck(branch, { x: 20, y: 20, w: 120, h: 60 }, 10);
    const d = diffPngs(png(main), png(branch), { noiseAmplitude: 0 });
    expect(d.regions[0]?.kind).toBe("change");
    expect(d.changed).toBe(true);
  });

  test("a size change with identical overlap has no regions but is changed", () => {
    const d = diffPngs(png(page(50, 50)), png(page(50, 80)));
    expect(d.regions).toEqual([]);
    expect(d.changed).toBe(true);
  });

  describe("shift regions", () => {
    test("a text block shifted half a pixel is a shift, and the run is not changed", () => {
      const d = diffPngs(png(shiftedText(0)), png(shiftedText(0.5)));
      expect(d.regions.length).toBeGreaterThan(0);
      expect(d.regions.every((r) => r.kind === "shift")).toBe(true);
      expect(d.regions[0]?.why).toMatch(/^moved /);
      expect(d.changed).toBe(false);
    });

    test("a vertical half-pixel shift is a shift too", () => {
      const down = softPage(300, 120, textBlock(20, 20, 0, 0.5));
      const d = diffPngs(png(shiftedText(0)), png(down));
      expect(d.regions.every((r) => r.kind === "shift")).toBe(true);
      expect(d.changed).toBe(false);
    });

    test("a whole pixel is a real move", () => {
      const d = diffPngs(png(shiftedText(0)), png(shiftedText(1)));
      expect(d.regions.length).toBeGreaterThan(0);
      expect(d.regions.every((r) => r.kind === "change")).toBe(true);
      expect(d.changed).toBe(true);
    });

    test("one button moved 1px away from its neighbour is a change", () => {
      const d = diffPngs(png(softPage(300, 150, buttons(0))), png(softPage(300, 150, buttons(1))));
      expect(d.regions.some((r) => r.kind === "change")).toBe(true);
      expect(d.regions.some((r) => r.kind === "shift")).toBe(false);
      expect(d.changed).toBe(true);
    });

    test.each([
      [0.25, false],
      [0.5, true],
    ])(
      "a %spx move of one line of text against the lines around it is never a shift",
      (step, changed) => {
        const d = diffPngs(
          png(softPage(300, 90, shiftedLine(0))),
          png(softPage(300, 90, shiftedLine(step))),
        );
        expect(d.regions.some((r) => r.kind === "shift")).toBe(false);
        expect(d.changed).toBe(changed);
      },
    );

    test("maxShift 0 turns the call off", () => {
      const d = diffPngs(png(shiftedText(0)), png(shiftedText(0.5)), { maxShift: 0 });
      expect(d.regions.some((r) => r.kind === "shift")).toBe(false);
      expect(d.regions[0]?.kind).toBe("change");
      expect(d.changed).toBe(true);
    });

    test("maxShift below the shift leaves it a change", () => {
      const d = diffPngs(png(shiftedText(0)), png(shiftedText(0.5)), { maxShift: 0.3 });
      expect(d.regions.every((r) => r.kind === "change")).toBe(true);
    });
  });
});
