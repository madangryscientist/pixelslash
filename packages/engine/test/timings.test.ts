import { describe, expect, test } from "vitest";
import { withTimings } from "../src/report-timings.ts";
import {
  addSteps,
  buildTimings,
  mergeShots,
  timingLine,
  type CaptureSteps,
} from "../src/timings.ts";

const steps = (n: number): CaptureSteps => ({
  navigateMs: n,
  settleMs: 4 * n,
  screenshotMs: 2 * n,
  settle: { fontsMs: n, imagesMs: n, networkIdleMs: n, framesMs: n },
});

/** The report for one shot of `captureMs` whose parts add up to 3 ms. */
const reportOf = (captureMs: number) =>
  withTimings("<body></body>", buildTimings(0, [{ name: "a", captureMs, ...steps(1) }]));

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

  test("capture's parts (PS-195): a pair adds up, the run sums them and keeps the launch apart", () => {
    expect(addSteps(steps(1), steps(10))).toEqual(steps(11));
    const t = buildTimings(
      performance.now(),
      [
        { name: "a", captureMs: 100, ...steps(10) },
        { name: "b", captureMs: 900, ...steps(100) },
      ],
      250,
    );
    expect(t).toMatchObject({ browserLaunchMs: 250, captureMs: 1000, ...steps(110) });
    // The parts are inside captureMs: the slowest shot is still the one with most capture.
    expect(t.shots.map((s) => s.name)).toEqual(["b", "a"]);
    expect(buildTimings(performance.now(), [{ name: "a", diffMs: 1 }])).not.toHaveProperty(
      "settle",
    );
    expect(buildTimings(performance.now(), [])).not.toHaveProperty("browserLaunchMs");
  });

  test("the overlap note shows only when the parts pass Capture; a run with no capture has no parts", () => {
    expect(reportOf(2)).toContain("pages shot at once overlap");
    expect(reportOf(9)).not.toContain("pages shot at once overlap");
    expect(withTimings("<body></body>", buildTimings(0, [{ name: "a", diffMs: 1 }]))).not.toContain(
      "Navigate",
    );
  });
});
