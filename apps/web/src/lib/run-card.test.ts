import { describe, expect, test } from "vitest";
import { metricBuild, metricShot, review, usage } from "./metrics-test-kit";
import { formatDuration as d } from "./format";
import { NOT_REPORTED, type RunCard, type RunCardInput, runCard } from "./run-card";

const finished = new Date("2026-10-27T10:00:04Z");

const card = (over: Partial<RunCardInput>): RunCard =>
  runCard({ build: metricBuild(), shots: [], defaultBranch: "main", recaptures: null, ...over });

const lines = (c: RunCard) =>
  [c.wall, ...c.counts, c.compare, ...c.tokens].filter((l) => l !== null);
const byKey = (c: RunCard, key: string) => lines(c).find((l) => l.key === key);

const times = (n: number) => Array.from({ length: n }, (_, i) => metricShot({ diffMs: i + 1 }));

describe("the per-compare line and cache hits", () => {
  const hit = metricShot({ diffMs: 0, cacheHit: true });

  test("a build of cache hits only says so and shows no percentile", () => {
    const c = card({ shots: [hit, metricShot({ diffMs: null, cacheHit: true })] });
    expect(c.compare?.value).toBe("2 snapshots · all cache hits, no compare ran");
    expect(byKey(c, "cache-hits")?.value).toBe("2");
    expect(byKey(c, "compares")?.value).toBe("0");
  });

  test("p95 and p99 appear at their gates, and the note names the p99 gate below it", () => {
    const under = card({ shots: times(499) }).compare;
    expect(under?.value).toContain(`p95 ${d(475)}`);
    expect(under?.value).toContain("p99 n/a (n = 499)");
    expect(under?.note).toContain("p99 from 500 compares");
    const at = card({ shots: times(500) }).compare;
    expect(at?.value).toContain(`p99 ${d(495)} (n = 500)`);
    expect(at?.note).not.toContain("p99 from");
  });
});

describe("runCard with timings", () => {
  const shots = [120, 40, 80].map((diffMs, i) => metricShot({ name: `s${i}`, diffMs }));
  const c = card({ build: metricBuild({ finishedAt: finished }), shots, recaptures: 2 });

  test("states the wall time, derived from the build's two moments", () => {
    expect(c.wall).toMatchObject({ value: d(4000), source: expect.stringContaining("derived") });
  });

  test("states each count with its source", () => {
    expect(byKey(c, "shots")?.value).toBe("3");
    expect(byKey(c, "compares")?.value).toBe("3");
    expect(byKey(c, "unmeasured")?.value).toBe("0");
    expect(byKey(c, "recaptures")).toMatchObject({
      value: "2",
      source: expect.stringContaining("CLI"),
    });
    // Auto-accept happens on the default branch only; on a feature branch the line is absent.
    expect(byKey(c, "auto-accepted")).toBeUndefined();
  });

  test("states the per-compare median, tail and n, and names the slowest", () => {
    expect(c.compare?.value).toBe(
      `3 snapshots · 3 compared · p50 ${d(80)} · slowest ${d(120)} · p99 n/a (n = 3)`,
    );
    expect(c.compare?.source).toBe("stored by the server");
    expect(c.compare?.note).toContain(`s0 (1280x720, light) ${d(120)}`);
  });
});

describe("runCard without timings", () => {
  const c = card({ shots: [metricShot({ measuredBy: "ci" })] });

  test("has no wall time, no compare time and no re-capture line", () => {
    expect(c.wall).toBeNull();
    expect(c.compare).toBeNull();
    expect(byKey(c, "recaptures")).toBeUndefined();
    expect(byKey(c, "compares")).toBeUndefined();
    expect(byKey(c, "compares-ci")?.value).toBe("1");
  });

  test("never shows a time it did not record as 0", () => {
    for (const line of lines(c)) expect(line.value).not.toMatch(/(^|\D)0\s(ms|s)\b/);
  });
});

describe("runCard tokens", () => {
  test("says usage was not reported when no call reported it", () => {
    const shots = [
      metricShot({
        aiReview: review(usage({ reported: 0, input: null, output: null, total: null })),
      }),
    ];
    expect(byKey(card({ shots }), "tokens-explain")?.value).toBe(NOT_REPORTED);
  });

  test("states in, out, total and the calls they cover", () => {
    const shots = [metricShot({ aiReview: review(usage({ calls: 3, reported: 2 })) })];
    expect(byKey(card({ shots }), "tokens-explain")).toMatchObject({
      value: "in 100 · out 20 · total 120",
      note: "covers 2 of 3 calls; the rest did not report usage",
    });
  });

  test("has no token line where no model call was stored", () => {
    expect(card({ shots: [metricShot()] }).tokens).toEqual([]);
  });
});
