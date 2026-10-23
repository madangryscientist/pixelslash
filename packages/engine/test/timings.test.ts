import { describe, expect, test } from "vitest";
import { buildTimings, mergeShots, timingLine } from "../src/timings.ts";

describe("timings (ob 1791)", () => {
  test("sums per step, leaves out a step no shot did, and puts the slowest shot first", () => {
    const t = buildTimings(performance.now(), [
      { name: "a", captureMs: 100, diffMs: 5 },
      { name: "b", captureMs: 900, diffMs: 20 },
    ]);
    expect(t.shots.map((s) => s.name)).toEqual(["b", "a"]);
    expect(t).toMatchObject({ captureMs: 1000, diffMs: 25 });
    expect(t).not.toHaveProperty("judgeMs");
    expect(t).not.toHaveProperty("upload");
    expect(t.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("the stderr line names only the steps that ran", () => {
    const t = buildTimings(performance.now(), [{ name: "a", captureMs: 8400, diffMs: 1200 }]);
    t.totalMs = 11_900;
    expect(timingLine({ ...t, upload: { totalMs: 2000, batches: [] } }, 12)).toBe(
      "timing: 12 shots, capture 8.4s, diff 1.2s, upload 2.0s, total 11.9s",
    );
    expect(timingLine({ totalMs: 0, shots: [] })).toBe("timing: 0 shots, total 0.0s");
  });

  test("mergeShots joins a capture list and a diff list by name", () => {
    expect(
      mergeShots(
        [{ name: "a", captureMs: 1 }],
        [
          { name: "a", diffMs: 2 },
          { name: "b", diffMs: 3 },
        ],
      ),
    ).toEqual([
      { name: "a", captureMs: 1, diffMs: 2 },
      { name: "b", diffMs: 3 },
    ]);
  });
});
