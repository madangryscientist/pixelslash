import type { BuildTimings } from "#/db/diff-json";
import { describe, expect, test } from "vitest";
import {
  CLI_TOTAL_NOTE,
  STEP_LABELS,
  SUMMARY_SKIPPED_NOTE,
  cliProfileRows,
  cliStepRows,
  percentile,
  serverStepRows,
  statsOf,
  summarise,
  totalMs,
  type TimedBuild,
} from "./timings";

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

  test("a clock that stepped back has no total, not a 0 and not a negative", () => {
    expect(totalMs(timed({ processingStartedAt: at(100), finishedAt: at(40) }))).toBeNull();
  });

  test("a run that ended the moment it began is a real 0", () => {
    expect(totalMs(timed({ processingStartedAt: at(5), finishedAt: at(5) }))).toBe(0);
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
    expect(stats.diff).toEqual({ p50: 500, p95: 1000, p99: null, max: 1000, n: 10, tail: "max" });
    expect(stats.explain).toEqual({
      p50: 2000,
      p95: 4000,
      p99: null,
      max: 4000,
      n: 4,
      tail: "max",
    });
    expect(stats.total).toEqual({ p50: 1000, p95: 2000, p99: null, max: 2000, n: 10, tail: "max" });
    expect(stats.queue).toBeNull();
    expect(stats.summary).toBeNull();
  });

  test("no builds is no stats at all", () => {
    expect(Object.values(summarise([]))).toEqual([null, null, null, null, null]);
  });
});

describe("the Total aggregate", () => {
  test("drops a build with a missing or negative span instead of counting it as 0", () => {
    const good = [1_000, 2_000, 3_000].map((span) =>
      timed({ processingStartedAt: at(0), finishedAt: at(span) }),
    );
    const noEnd = timed({ processingStartedAt: at(0) });
    const noStart = timed({ finishedAt: at(10) });
    const backwards = timed({ processingStartedAt: at(100), finishedAt: at(40) });
    const stats = summarise([...good, noEnd, noStart, backwards]).total;
    expect(stats).toEqual({ p50: 2_000, p95: 3_000, p99: null, max: 3_000, n: 3, tail: "max" });
  });

  test("a project whose only builds have no span has no Total, not 0 / 0", () => {
    const backwards = timed({ diffMs: 5, processingStartedAt: at(100), finishedAt: at(40) });
    const stats = summarise([backwards]);
    expect(stats.total).toBeNull();
    expect(stats.diff?.n).toBe(1);
  });
});

const buildsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => timed({ diffMs: (i + 1) * 10 }));

describe("max or p95", () => {
  test("under 20 builds the tail is the slowest and says max", () => {
    const stats = summarise(buildsOf(19)).diff;
    expect(stats).toMatchObject({ n: 19, tail: "max", max: 190, p95: 190 });
  });

  test("from 20 builds the tail is the 95th percentile", () => {
    const stats = summarise(buildsOf(20)).diff;
    expect(stats).toMatchObject({ n: 20, tail: "p95", p95: 190, max: 200 });
  });
});

describe("the build page's rows", () => {
  const ran = timed({
    queueMs: 12_000,
    diffMs: 25_000,
    explainMs: 4_000,
    summaryMs: 26,
    processingStartedAt: at(0),
    finishedAt: at(30_000),
  });

  test("the total says it starts at the diff, and the wait is its own step", () => {
    const rows = serverStepRows(ran, true);
    expect(rows.map((r) => r.label)).toEqual([
      "before diff",
      "diff",
      "AI explanations",
      "AI summary",
      "total from diff start",
    ]);
    expect(STEP_LABELS.total).toBe("total from diff start");
  });

  test("an AI summary step that stored no summary says it was skipped; one that stored says nothing", () => {
    expect(serverStepRows(ran, false).find((r) => r.key === "summary")?.note).toBe(
      SUMMARY_SKIPPED_NOTE,
    );
    expect(serverStepRows(ran, true).find((r) => r.key === "summary")?.note).toBeUndefined();
    // No note on a step that is not the summary, and none on a step that did not run.
    expect(serverStepRows(ran, false).filter((r) => r.note)).toHaveLength(1);
    expect(serverStepRows(timed({ diffMs: 1 }), false).map((r) => r.key)).toEqual(["diff"]);
  });

  test("a build with a backwards span shows no total", () => {
    const rows = serverStepRows(
      timed({ diffMs: 9, processingStartedAt: at(100), finishedAt: at(40) }),
      true,
    );
    expect(rows.map((r) => r.key)).toEqual(["diff"]);
  });

  test("the CLI's steps are those it sent, and its total note says wall-clock", () => {
    const rows = cliStepRows({ totalMs: 17_000, upload: { totalMs: 17_000 }, captureMs: 2_000 });
    expect(rows.map((r) => r.key)).toEqual(["capture", "upload", "total"]);
    expect(cliStepRows(null)).toEqual([]);
    expect(CLI_TOTAL_NOTE).toMatch(/wall-clock/);
    expect(CLI_TOTAL_NOTE).toMatch(/less than/);
  });
});

describe("the CLI's speed profile", () => {
  const full: BuildTimings = {
    totalMs: 20_000,
    captureWallMs: 4_200,
    workers: { capture: 4, upload: 4 },
    host: { cores: 16, loadStart: 3.2, loadEnd: 4.1 },
    captureMs: 10_000,
    setupMs: 500,
    navigateMs: 1_000,
    settleMs: 7_000,
    storyMs: 600,
    screenshotMs: 1_200,
    measureMs: 300,
    settle: { fontsMs: 100, imagesMs: 200, networkIdleMs: 5_500, framesMs: 30 },
    upload: {
      totalMs: 9_000,
      batches: [
        {
          step: "upload",
          count: 120,
          ms: 20_000,
          p50Ms: 180,
          p90Ms: 420,
          maxMs: 900,
          wallMs: 3_200,
        },
        {
          step: "finalize",
          count: 1,
          ms: 9_500,
          p50Ms: 9_500,
          p90Ms: 9_500,
          maxMs: 9_500,
          wallMs: 9_500,
        },
      ],
    },
    shots: [],
  };

  test("capture wall against worker time and the count, each part's share, network idle inside settle", () => {
    const rows = Object.fromEntries(cliProfileRows(full).map((r) => [r.key, r.text]));
    expect(rows["capture-wall"]).toMatch(/4\.2.s against 10.s of worker time, on 4 workers/);
    expect(rows["capture-parts"]).toBe(
      "setup 5%, navigate 10%, settle 70% (fonts 1%, images 2%, network idle 55%, frames <1%, story 6%), screenshot 12%, measure 3%, of worker time",
    );
  });

  test("each request kind has its p50, p90, max and wall; the host has its cores and load", () => {
    const rows = Object.fromEntries(cliProfileRows(full).map((r) => [r.key, r.text]));
    expect(rows["requests-upload"]).toMatch(
      /^120 requests on 4 workers: p50 180.ms, p90 420.ms, max 900.ms, 3\.2.s wall$/,
    );
    expect(rows["requests-finalize"]).toMatch(/^1 request: p50 9\.5.s/);
    expect(rows.host).toBe("16 cores, load 3.2 at the start and 4.1 at the end");
  });

  test("a build from an older CLI, or without timings, has no profile rows", () => {
    expect(cliProfileRows(null)).toEqual([]);
    const old: BuildTimings = {
      totalMs: 900,
      captureMs: 400,
      upload: { totalMs: 300, batches: [{ step: "upload", count: 2, ms: 250 }] },
      shots: [],
    };
    expect(cliProfileRows(old)).toEqual([]);
  });
});

const values = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("the p99 gate", () => {
  test("a step has no p99 under 100 builds, never a stand-in", () => {
    expect(statsOf(values(99))).toMatchObject({ p99: null, n: 99, p95: 95, tail: "p95" });
  });
});
