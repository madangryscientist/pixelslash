import { describe, expect, test } from "vitest";
import type { DiffRegion } from "#/db/schema";
import { edgeTouches } from "./ignore-edge";

const region = (x: number, y: number, w: number, h: number) =>
  ({ x, y, w, h, changedPixels: w * h, antialiasedPixels: 0, kind: "change" }) satisfies DiffRegion;

const box = { x: 10, y: 10, width: 10, height: 10 };

describe("the edge-touch warning (ob 1499)", () => {
  test("a change sharing an ignore box's edge warns", () => {
    // Right of the box, starting on its right edge (x 20).
    expect(edgeTouches([region(20, 12, 4, 4)], [box])).toHaveLength(1);
    // Above it, ending on its top edge.
    expect(edgeTouches([region(12, 6, 4, 4)], [box])).toHaveLength(1);
    // Diagonal, corner to corner.
    expect(edgeTouches([region(6, 6, 4, 4)], [box])).toHaveLength(1);
  });

  test("a change across the edge warns", () => {
    expect(edgeTouches([region(15, 15, 10, 2)], [box])).toHaveLength(1);
  });

  test("a change clear of every box, or wholly inside one, does not", () => {
    expect(edgeTouches([region(21, 12, 4, 4)], [box])).toEqual([]);
    expect(edgeTouches([region(12, 12, 4, 4)], [box])).toEqual([]);
    expect(edgeTouches([region(12, 12, 4, 4)], [])).toEqual([]);
  });

  test("only a change warns, not noise or a shift", () => {
    expect(
      edgeTouches(
        [
          { ...region(20, 12, 4, 4), kind: "noise" },
          { ...region(20, 12, 4, 4), kind: "shift" },
        ],
        [box],
      ),
    ).toEqual([]);
  });

  test("any box of the union counts: config, manifest and UI alike", () => {
    const config = { x: 0, y: 0, width: 5, height: 5 };
    const ui = { x: 30, y: 30, width: 5, height: 5 };
    const near = region(35, 30, 2, 2);
    expect(edgeTouches([near], [config])).toEqual([]);
    expect(edgeTouches([near], [config, ui])).toEqual([near]);
  });
});
