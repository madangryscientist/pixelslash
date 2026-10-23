import { describe, expect, test } from "vitest";
import { percentile, summarise, totalMs, type TimedBuild } from "./timings";

const at = (ms: number) => new Date(1_700_000_000_000 + ms);
const timed = (over: Partial<TimedBuild> = {}): TimedBuild => ({
  queueMs: null,
  diffMs: null,
  explainMs: null,
  summaryMs: null,
  finishedAt: null,
  processingStartedAt: null,
  ...over,
});

describe("percentile", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);

  test("is the nearest rank: p95 of 20 is the 19th, p50 the 10th", () => {
    expect(percentile(twenty, 0.5)).toBe(100);
    expect(percentile(twenty, 0.95)).toBe(190);
    expect(percentile(twenty, 1)).toBe(200);
  });

  test("one value is every percentile, and a tiny p still picks the first", () => {
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile(twenty, 0.001)).toBe(10);
  });
});

describe("totalMs", () => {
  test("is the claim to the last server step, and null without both ends", () => {
    expect(totalMs(timed({ processingStartedAt: at(0), finishedAt: at(4_500) }))).toBe(4_500);
    expect(totalMs(timed({ processingStartedAt: at(0) }))).toBeNull();
    expect(totalMs(timed({ finishedAt: at(10) }))).toBeNull();
  });

  test("a clock that stepped back never gives a negative total", () => {
    expect(totalMs(timed({ processingStartedAt: at(100), finishedAt: at(40) }))).toBe(0);
  });
});

describe("summarise", () => {
  test("p50 and p95 per step over a fixed set, leaving out builds that did not run the step", () => {
    const diffs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const rows = diffs.map((diffMs, i) =>
      timed({
        diffMs,
        // Only the first four explained.
        explainMs: i < 4 ? (i + 1) * 1000 : null,
        processingStartedAt: at(0),
        finishedAt: at(diffMs * 2),
      }),
    );
    const stats = summarise(rows);
    expect(stats.diff).toEqual({ p50: 500, p95: 1000, n: 10 });
    expect(stats.explain).toEqual({ p50: 2000, p95: 4000, n: 4 });
    expect(stats.total).toEqual({ p50: 1000, p95: 2000, n: 10 });
    expect(stats.queue).toBeNull();
    expect(stats.summary).toBeNull();
  });

  test("no builds is no stats at all", () => {
    expect(Object.values(summarise([]))).toEqual([null, null, null, null, null]);
  });
});
