import { describe, expect, test } from "vitest";
import { coversMostOfShot } from "./thumb-crop";

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
