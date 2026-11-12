import { describe, expect, test } from "vitest";
import { THUMB_RATIO, coversMostOfShot, thumbWindow } from "./thumb-crop";

const shot = { width: 1000, height: 2000 };

describe("coversMostOfShot", () => {
  test("a change across the whole page covers most of it", () => {
    expect(coversMostOfShot([{ w: 1000, h: 2000, kind: "change" }], shot)).toBe(true);
  });

  test("a small region keeps its zoomed highlight", () => {
    expect(coversMostOfShot([{ w: 200, h: 100, kind: "change" }], shot)).toBe(false);
  });

  test("two strips at opposite ends of a page do not, though their crop spans it", () => {
    const strips = [
      { w: 1000, h: 60, kind: "change" },
      { w: 1000, h: 60, kind: "change" },
    ];
    expect(coversMostOfShot(strips, shot)).toBe(false);
  });

  test("noise and shift boxes are not the change", () => {
    expect(coversMostOfShot([{ w: 1000, h: 2000, kind: "noise" }], shot)).toBe(false);
  });
});

describe("thumbWindow", () => {
  const pageHeight = 5000;

  test("a thin wide change on a tall page grows to 16:10, centred on the change", () => {
    const view = thumbWindow({ x: 0, y: 2000, w: 1300, h: 40 }, pageHeight);
    expect(view.w / view.h).toBeCloseTo(THUMB_RATIO, 5);
    expect(view.x).toBe(0);
    expect(view.y + view.h / 2).toBeCloseTo(2020, 5);
  });

  test("the grown window stays inside the shot at the top and the bottom", () => {
    expect(thumbWindow({ x: 0, y: 0, w: 1300, h: 40 }, pageHeight).y).toBe(0);
    const bottom = thumbWindow({ x: 0, y: 4960, w: 1300, h: 40 }, pageHeight);
    expect(bottom.y + bottom.h).toBe(pageHeight);
    expect(bottom.w / bottom.h).toBeCloseTo(THUMB_RATIO, 5);
  });

  test("a crop that is not wider than 16:10 is left as it is", () => {
    const crop = { x: 600, y: 100, w: 40, h: 400 };
    expect(thumbWindow(crop, pageHeight)).toEqual(crop);
  });

  test("a shot too short to grow into keeps what it has", () => {
    expect(thumbWindow({ x: 0, y: 0, w: 1000, h: 100 }, 200)).toEqual({
      x: 0,
      y: 0,
      w: 1000,
      h: 200,
    });
  });
});
