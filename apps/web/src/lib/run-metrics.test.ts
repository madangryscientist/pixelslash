import { describe, expect, test } from "vitest";
import { metricBuild, metricShot, review, usage } from "./metrics-test-kit";
import { compareMsOf, compareTimes, countRun, runTokens, wallMs } from "./run-metrics";

describe("wallMs", () => {
  test("is created to finished, and absent before a build finished", () => {
    const createdAt = new Date("2026-10-27T10:00:00Z");
    expect(wallMs({ createdAt, finishedAt: new Date("2026-10-27T10:00:04Z") })).toBe(4000);
    expect(wallMs({ createdAt, finishedAt: null })).toBeNull();
    // A clock that stepped back gives no span, not a negative or a 0.
    expect(wallMs({ createdAt, finishedAt: new Date("2026-10-27T09:59:00Z") })).toBeNull();
  });
});

describe("compareMsOf", () => {
  test("is the stored time of a shot the server measured", () => {
    expect(compareMsOf(metricShot({ diffMs: 120 }))).toBe(120);
    expect(compareMsOf(metricShot({ diffStatus: "changed", diffMs: 80 }))).toBe(80);
  });

  test("is absent for a shot never timed, measured by CI, or no longer measured", () => {
    expect(compareMsOf(metricShot({ diffMs: null }))).toBeNull();
    expect(compareMsOf(metricShot({ measuredBy: "ci", diffMs: 50 }))).toBeNull();
    // A re-run that cleared the result leaves the column: the time is not the shot's any more.
    expect(compareMsOf(metricShot({ diffStatus: null, diffMs: 50 }))).toBeNull();
    expect(compareMsOf(metricShot({ diffStatus: "new", diffMs: 50 }))).toBeNull();
  });
});

describe("countRun", () => {
  const shots = [
    metricShot(),
    metricShot({ diffStatus: "changed" }),
    metricShot({ measuredBy: "ci" }),
    metricShot({ diffStatus: "new", measuredBy: null }),
    metricShot({ diffStatus: null, measuredBy: null }),
    metricShot({ diffStatus: "removed", measuredBy: null }),
    metricShot({ diffStatus: "changed", flakeId: "f", flakyPolicy: "skip" }),
  ];

  test("counts the held shots, the compares by where they ran, and the unmeasured", () => {
    expect(countRun(metricBuild(), shots, "main")).toEqual({
      shots: 6,
      compares: { server: 3, ci: 1 },
      notMeasured: 1,
      skippedFlaky: 1,
      autoAccepted: null,
    });
  });

  test("counts auto-accepted shots on the default branch only, never a reviewer's", () => {
    const accepted = [
      metricShot({ reviewState: "accepted" }),
      metricShot({ reviewState: "accepted", reviewedBy: "u1" }),
    ];
    expect(countRun(metricBuild({ branch: "main" }), accepted, "main").autoAccepted).toBe(1);
    expect(countRun(metricBuild(), accepted, "main").autoAccepted).toBeNull();
  });
});

describe("compareTimes", () => {
  test("reads the server's per-shot times, with the three slowest by name", () => {
    const shots = [10, 40, 20, 30].map((diffMs, i) => metricShot({ name: `s${i}`, diffMs }));
    const times = compareTimes(metricBuild(), [...shots, metricShot()]);
    expect(times?.source).toBe("server");
    expect(times?.stats).toMatchObject({ p50: 20, max: 40, n: 4, tail: "max" });
    expect(times?.slowest.map((s) => s.ms)).toEqual([40, 30, 20]);
    expect(times?.slowest[0]?.label).toBe("s1 (1280x720, light)");
  });

  test("falls back to the CLI's per-shot times, and is null when nobody timed one", () => {
    const shots = [metricShot({ measuredBy: "ci" })];
    const sent = metricBuild({ timings: { shots: [{ name: "a", diffMs: 5 }, { name: "b" }] } });
    expect(compareTimes(sent, shots)).toMatchObject({ source: "cli", stats: { n: 1, p50: 5 } });
    expect(compareTimes(metricBuild(), shots)).toBeNull();
    expect(compareTimes(metricBuild({ timings: { shots: [{ name: "a" }] } }), shots)).toBeNull();
  });
});

describe("runTokens", () => {
  test("sums the stored explanations' tokens and keeps the summary's apart", () => {
    const shots = [
      metricShot({ aiReview: review(usage()) }),
      metricShot({ aiReview: review(usage({ calls: 2, reported: 1 })) }),
      metricShot(),
    ];
    const summary = usage({ input: 7, output: 3, total: 10 });
    const build = metricBuild({ aiSummary: { model: "m", at: 0, sentences: [], usage: summary } });
    expect(runTokens(build, shots)).toEqual({
      explain: { calls: 3, reported: 2, input: 200, output: 40, total: 240, unrecorded: 0 },
      summary,
    });
  });

  test("is null where nothing ran, or where it ran before tokens were stored", () => {
    expect(runTokens(metricBuild(), [metricShot()])).toEqual({ explain: null, summary: null });
    const old = metricBuild({ aiSummary: { model: "m", at: 0, sentences: [] } });
    const tokens = runTokens(old, [metricShot({ aiReview: review() })]);
    expect(tokens).toEqual({ explain: null, summary: null });
  });
});
