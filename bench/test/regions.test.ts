import { describe, expect, test } from "vitest";
import { extractRegions, iou, maskFromRgba, type Mask } from "../src/regions.ts";

function maskOf(
  width: number,
  height: number,
  rects: Array<[number, number, number, number]>,
): Mask {
  const changed = new Uint8Array(width * height);
  for (const [x, y, w, h] of rects) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) changed[j * width + i] = 1;
  }
  return { width, height, changed };
}

describe("extractRegions", () => {
  test("no changed pixels, no regions", () => {
    expect(extractRegions(maskOf(20, 20, []))).toEqual([]);
  });

  test("near blobs merge, far blobs stay apart, largest first", () => {
    const mask = maskOf(100, 40, [
      [2, 2, 4, 4],
      [10, 2, 4, 4],
      [60, 20, 10, 10],
    ]);
    expect(extractRegions(mask)).toEqual([
      { x: 60, y: 20, w: 10, h: 10 },
      { x: 2, y: 2, w: 12, h: 4 },
    ]);
  });

  test("a region is the box of the changed pixels, not of the dilated blob", () => {
    expect(extractRegions(maskOf(50, 50, [[20, 20, 1, 1]]))).toEqual([
      { x: 20, y: 20, w: 1, h: 1 },
    ]);
  });
});

describe("maskFromRgba", () => {
  test("alpha above zero is changed", () => {
    const rgba = new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255]);
    expect(Array.from(maskFromRgba(2, 1, rgba).changed)).toEqual([0, 1]);
  });
});

describe("iou", () => {
  const box = { x: 10, y: 10, w: 10, h: 10 };

  test("an exact match is 1", () => {
    expect(iou([box], box, 40, 40)).toBe(1);
  });

  test("no regions is 0", () => {
    expect(iou([], box, 40, 40)).toBe(0);
  });

  test("half the box, nothing else, is 0.5", () => {
    expect(iou([{ x: 10, y: 10, w: 5, h: 10 }], box, 40, 40)).toBe(0.5);
  });

  test("a stray region outside the box lowers it", () => {
    expect(iou([box, { x: 30, y: 30, w: 10, h: 10 }], box, 40, 40)).toBe(0.5);
  });

  test("overlapping regions are not counted twice", () => {
    expect(iou([box, box], box, 40, 40)).toBe(1);
  });
});
