import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { similarity, type Raster } from "../src/similarity.ts";
import { similarityOfPngs } from "../src/similarity-png.ts";

type Rgb = [number, number, number];

/** A raster `w` x `h` logical px at `scale`, painted by `paint(x, y)` in logical px. */
function raster(w: number, h: number, scale: number, paint: (x: number, y: number) => Rgb): Raster {
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(Math.floor(x / scale), Math.floor(y / scale));
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

/** A header band, a card and a button on a white screen: something with structure to compare. */
const screen = (x: number, y: number): Rgb => {
  if (y < 24) return [30, 60, 160];
  if (x > 20 && x < 140 && y > 60 && y < 120) return [230, 230, 240];
  if (x > 40 && x < 120 && y > 140 && y < 170) return [20, 140, 60];
  return [255, 255, 255];
};

const png = (r: Raster): Uint8Array => {
  const img = new PNG({ width: r.width, height: r.height });
  img.data = Buffer.from(Uint8Array.from(r.data));
  return PNG.sync.write(img);
};

describe("similarity", () => {
  test("identical images score 1", () => {
    const a = raster(160, 200, 1, screen);
    expect(similarity({ raster: a, scale: 1 }, { raster: a, scale: 1 })).toBe(1);
  });

  test("a shifted image scores lower", () => {
    const a = raster(160, 200, 1, screen);
    const shifted = raster(160, 200, 1, (x, y) => screen(x - 30, y - 25));
    const score = similarity({ raster: a, scale: 1 }, { raster: shifted, scale: 1 });
    expect(score).not.toBeNull();
    expect(score).toBeLessThan(0.9);
  });

  test("a recoloured image scores lower, even at the same luminance", () => {
    const a = raster(160, 200, 1, screen);
    const recoloured = raster(160, 200, 1, (x, y) => {
      const [r, g, b] = screen(x, y);
      return [b, r, g];
    });
    const score = similarity({ raster: a, scale: 1 }, { raster: recoloured, scale: 1 });
    expect(score).not.toBeNull();
    // Most of the screen is white, which the swap leaves alone; the coloured parts still show.
    expect(score).toBeLessThan(0.95);
  });

  test("the same screen at 1x and 3x scores 1: each is read at its own scale", () => {
    const web = raster(160, 200, 1, screen);
    const native = raster(160, 200, 3, screen);
    expect(native.width).toBe(480);
    expect(similarity({ raster: web, scale: 1 }, { raster: native, scale: 3 })).toBe(1);
    // Read the 3x shot as 1x and the two no longer line up.
    const wrong = similarity({ raster: web, scale: 1 }, { raster: native, scale: 1 });
    expect(wrong).toBeLessThan(1);
  });

  test("a fractional scale is normalised too", () => {
    const web = raster(160, 200, 1, screen);
    const native = raster(160, 200, 2.625, screen);
    const score = similarity({ raster: web, scale: 1 }, { raster: native, scale: 2.625 });
    expect(score).toBeGreaterThan(0.95);
  });

  test("only the overlap is compared when the sizes differ", () => {
    const tall = raster(160, 400, 1, (x, y) => (y < 200 ? screen(x, y) : [255, 0, 0]));
    const short = raster(160, 200, 1, screen);
    expect(similarity({ raster: tall, scale: 1 }, { raster: short, scale: 1 })).toBe(1);
  });

  test("a null scale reads as 1", () => {
    const a = raster(160, 200, 1, screen);
    expect(similarity({ raster: a, scale: null }, { raster: a, scale: 1 })).toBe(1);
  });

  test("it is symmetric", () => {
    const a = raster(160, 200, 1, screen);
    const b = raster(160, 200, 1, (x, y) => screen(x - 10, y));
    expect(similarity({ raster: a, scale: 1 }, { raster: b, scale: 1 })).toBe(
      similarity({ raster: b, scale: 1 }, { raster: a, scale: 1 }),
    );
  });

  test("no overlap gives no score, not 0", () => {
    const a = raster(160, 200, 1, screen);
    const empty: Raster = { width: 0, height: 0, data: new Uint8Array(0) };
    expect(similarity({ raster: a, scale: 1 }, { raster: empty, scale: 1 })).toBeNull();
    // 1 px at 3x is a third of a logical px: nothing to compare.
    const sliver = raster(0.34, 200, 3, screen);
    expect(sliver.width).toBe(1);
    expect(similarity({ raster: a, scale: 1 }, { raster: sliver, scale: 3 })).toBeNull();
  });

  test("a raster short of bytes gives no score", () => {
    const a = raster(160, 200, 1, screen);
    const cut: Raster = { width: 160, height: 200, data: new Uint8Array(100) };
    expect(similarity({ raster: a, scale: 1 }, { raster: cut, scale: 1 })).toBeNull();
  });

  test("a tiny image is scored on its one window", () => {
    const a = raster(4, 4, 1, () => [10, 20, 30]);
    expect(similarity({ raster: a, scale: 1 }, { raster: a, scale: 1 })).toBe(1);
  });

  test("transparent pixels read as white", () => {
    const white = raster(40, 40, 1, () => [255, 255, 255]);
    const clear: Raster = { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) };
    expect(similarity({ raster: white, scale: 1 }, { raster: clear, scale: 1 })).toBe(1);
  });
});

describe("similarityOfPngs", () => {
  test("scores two stored shots at their own scales", () => {
    const web = png(raster(160, 200, 1, screen));
    const native = png(raster(160, 200, 3, screen));
    expect(similarityOfPngs({ png: web, scale: 1 }, { png: native, scale: 3 })).toBe(1);
  });

  test("bytes that are not a PNG give no score", () => {
    const web = png(raster(160, 200, 1, screen));
    expect(
      similarityOfPngs({ png: web, scale: 1 }, { png: new Uint8Array([1, 2, 3]), scale: 1 }),
    ).toBeNull();
  });

  test("a shot over the pixel cap gives no score without being decoded", () => {
    const web = png(raster(160, 200, 1, screen));
    const huge = png(raster(160, 200, 1, screen));
    // Header claims 5000x5000: over the cap, so it is refused before any decode.
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 5000);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 5000);
    expect(similarityOfPngs({ png: web, scale: 1 }, { png: huge, scale: 1 })).toBeNull();
  });
});
