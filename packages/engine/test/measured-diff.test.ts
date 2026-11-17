import { describe, expect, test } from "vitest";
import type { Raster } from "../src/diff-probe.ts";
import { measuredDiff } from "../src/measured.ts";
import { newField, PIXEL_CHANGED } from "../src/regions.ts";
import { softPage, textBlock } from "./soft-page.ts";

/** The overlap of every pair below (the smaller size on each axis), which is the 300x120 shot. */
const OVERLAP = { width: 300, height: 120 };

/** Lines of soft-edged text, `dx` pixels along: half a pixel is a rendering shift at equal size. */
function text(width: number, height: number, dx: number): Raster {
  const { data } = softPage(width, height, textBlock(20, 20, dx));
  return { width, height, data: new Uint8Array(data) };
}

/**
 * Measure the pair as the pixel loop would hand it over: the diff field is the overlap's, with
 * every pixel that differs there marked changed.
 */
function measure(main: Raster, branch: Raster) {
  const field = newField(OVERLAP.width, OVERLAP.height);
  let changedPixels = 0;
  for (let y = 0; y < OVERLAP.height; y++) {
    for (let x = 0; x < OVERLAP.width; x++) {
      const a = (y * main.width + x) << 2;
      const b = (y * branch.width + x) << 2;
      if (main.data[a] === branch.data[b]) continue;
      field.kind[y * OVERLAP.width + x] = PIXEL_CHANGED;
      field.amplitude[y * OVERLAP.width + x] = 255;
      changedPixels++;
    }
  }
  // As the WASM path does: the overlay is the larger of the two shots, the diff field the overlap.
  const width = Math.max(main.width, branch.width);
  const height = Math.max(main.height, branch.height);
  const overlay: Raster = { width, height, data: new Uint8Array(width * height * 4) };
  const encoded: Raster[] = [];
  const d = measuredDiff(
    [main, branch],
    overlay,
    { changedPixels, antialiased: 0, ignoredPixels: 0, ignored: [], field },
    {
      encode: (o) => {
        encoded.push(o);
        return Buffer.from("png");
      },
    },
  );
  return { d, changedPixels, overlay, encoded };
}

const main = () => text(OVERLAP.width, OVERLAP.height, 0);

/** `measuredDiff` called directly, as the WASM path calls it: the rasters, the counts and an overlay the size of the larger shot. */
describe("measuredDiff on a size mismatch", () => {
  test("the same two shots at equal size are a rendering shift (the label this must not get)", () => {
    const { d } = measure(main(), text(OVERLAP.width, OVERLAP.height, 0.5));
    expect(d.regions.map((r) => r.kind)).toEqual(["shift"]);
  });

  test.each([
    ["taller", 300, 160],
    ["wider", 340, 120],
    ["both", 340, 160],
  ])(
    "Branch %s than Main: both sizes are reported, and the overlay is the larger one",
    (_, w, h) => {
      const { d } = measure(main(), text(w, h, 0.5));
      expect([d.mainWidth, d.mainHeight]).toEqual([300, 120]);
      expect([d.branchWidth, d.branchHeight]).toEqual([w, h]);
      expect([d.width, d.height]).toEqual([w, h]);
    },
  );

  test("is changed, and encodes the overlay it was given", () => {
    const { d, overlay, encoded } = measure(main(), text(300, 160, 0.5));
    expect(d.changed).toBe(true);
    expect(encoded[0]).toBe(overlay);
    expect(d.overlay.toString()).toBe("png");
    expect(d.settledBy).toBe("measured");
  });

  test("is changed even when nothing in the overlap differs", () => {
    const { d } = measure(main(), text(300, 160, 0));
    expect(d.changedPixels).toBe(0);
    expect(d.regions).toEqual([]);
    expect(d.changed).toBe(true);
  });

  test("every region lies inside the overlap rectangle", () => {
    const { d } = measure(main(), text(300, 160, 0.5));
    expect(d.regions.length).toBeGreaterThan(0);
    for (const r of d.regions) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(OVERLAP.width);
      expect(r.y + r.h).toBeLessThanOrEqual(OVERLAP.height);
    }
  });

  test("no region is labelled shift: there is no common grid to move along", () => {
    for (const [w, h] of [
      [300, 160],
      [340, 120],
      [340, 160],
    ] as const) {
      const bigger = measure(main(), text(w, h, 0.5)).d;
      const smaller = measure(text(w, h, 0), text(OVERLAP.width, OVERLAP.height, 0.5)).d;
      for (const d of [bigger, smaller]) {
        expect(d.regions.length).toBeGreaterThan(0);
        expect(d.regions.map((r) => r.kind)).toEqual(d.regions.map(() => "change"));
      }
    }
  });

  test("the counts are the ones it was handed", () => {
    const { d, changedPixels } = measure(main(), text(300, 160, 0.5));
    expect(d.specks).toEqual({ count: 0, pixels: 0 });
    expect(d.changedPixels).toBe(changedPixels);
    expect(d.regions.reduce((n, r) => n + r.changedPixels, 0)).toBe(changedPixels);
  });
});
