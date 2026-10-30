import { describe, expect, test } from "vitest";
import { type BranchBuildRow, BRANCH_WINDOW, branchMetrics, sparkPoints } from "./branch-metrics";

const start = Date.parse("2026-10-27T10:00:00Z");

/** The `i`-th build of the window, finished `wall` ms after it was created (null: not finished). */
function row(i: number, wall: number | null, compareMs: number[] = []): BranchBuildRow {
  const createdAt = new Date(start + i * 60_000);
  return {
    id: `b${i}`,
    createdAt,
    finishedAt: wall === null ? null : new Date(createdAt.getTime() + wall),
    compares: compareMs.length,
    compareMs,
  };
}

describe("branchMetrics", () => {
  test("an empty branch has no figures, only the window", () => {
    expect(branchMetrics([])).toEqual({
      window: BRANCH_WINDOW,
      builds: 0,
      wall: null,
      trend: [],
      compares: 0,
      compareTime: null,
    });
  });

  test("a single build is one value, with n = 1", () => {
    const metrics = branchMetrics([row(0, 4000, [100])]);
    expect(metrics.wall).toMatchObject({ p50: 4000, max: 4000, n: 1, tail: "max" });
    expect(metrics.compareTime).toMatchObject({ p50: 100, n: 1 });
  });

  test("an unfinished build and an untimed shot are left out, not counted as 0", () => {
    const metrics = branchMetrics([row(0, null, []), row(1, 3000, [50, 70]), row(2, null, [90])]);
    expect(metrics.builds).toBe(3);
    expect(metrics.wall).toMatchObject({ p50: 3000, n: 1 });
    expect(metrics.trend).toEqual([{ id: "b1", ms: 3000 }]);
    expect(metrics.compares).toBe(3);
    expect(metrics.compareTime).toMatchObject({ p50: 70, n: 3 });
  });

  test("the trend runs oldest first whatever the rows' order", () => {
    const metrics = branchMetrics([row(2, 300), row(0, 100), row(1, 200)]);
    expect(metrics.trend.map((p) => p.id)).toEqual(["b0", "b1", "b2"]);
  });
});

describe("sparkPoints", () => {
  test("two points are no trend: nothing is drawn", () => {
    expect(sparkPoints([], 100, 20)).toBe("");
    expect(
      sparkPoints(
        [
          { id: "a", ms: 1 },
          { id: "b", ms: 2 },
        ],
        100,
        20,
      ),
    ).toBe("");
  });

  test("three points span the box, slowest at the top", () => {
    const trend = [100, 300, 200].map((ms, i) => ({ id: `b${i}`, ms }));
    expect(sparkPoints(trend, 100, 20)).toBe("0,20 50,0 100,10");
  });

  test("equal values draw a flat line, not a division by zero", () => {
    const trend = [5, 5, 5].map((ms, i) => ({ id: `b${i}`, ms }));
    expect(sparkPoints(trend, 100, 20)).toBe("0,20 50,20 100,20");
  });
});
