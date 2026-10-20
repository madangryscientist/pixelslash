import { describe, expect, test } from "vitest";
import { caseSetChanges, compareCounts, guard, verdictFlips } from "../src/guard.ts";
import { parseResults, type Counts, type CorpusSummary } from "../src/results-json.ts";
import type { CorpusId } from "../src/corpus.ts";

const counts = (over: Partial<Counts> = {}): Counts => ({
  realCaught: 30,
  realTotal: 32,
  noiseFlagged: 20,
  noiseTotal: 20,
  identicalFlagged: 0,
  identicalTotal: 5,
  ...over,
});

const names = (c: Counts) =>
  compareCounts("main", counts(), c)
    .filter((m) => m.worse)
    .map((m) => m.name);

describe("compareCounts", () => {
  test("the same numbers are not worse", () => {
    expect(names(counts())).toEqual([]);
  });

  test("fewer real changes caught is worse", () => {
    expect(names(counts({ realCaught: 29 }))).toEqual(["real caught"]);
  });

  test("more noise flagged is worse, fewer is better", () => {
    expect(names(counts({ noiseFlagged: 21, noiseTotal: 21 }))).toEqual([]);
    expect(names(counts({ noiseFlagged: 15 }))).toEqual([]);
    const before = counts({ noiseFlagged: 10 });
    const worse = compareCounts("main", before, counts({ noiseFlagged: 11 })).filter(
      (m) => m.worse,
    );
    expect(worse.map((m) => m.name)).toEqual(["noise flagged"]);
  });

  test("an identical pair flagged is worse", () => {
    expect(names(counts({ identicalFlagged: 1 }))).toEqual(["identical flagged"]);
  });

  test("a corpus that grew compares by rate, not by count", () => {
    // 30/32 -> 31/33 is 93.75% -> 93.9%: better, though a count-for-count read would call 33 more cases odd.
    expect(names(counts({ realCaught: 31, realTotal: 33 }))).toEqual([]);
    expect(names(counts({ realCaught: 30, realTotal: 33 }))).toEqual(["real caught"]);
  });
});

const summary = (c: Counts, verdicts: Record<string, boolean> = {}): CorpusSummary => ({
  cases: Object.keys(verdicts).length,
  pixelslash: c,
  argos: null,
  verdicts,
});
const both = (main: CorpusSummary, holdout: CorpusSummary): Record<CorpusId, CorpusSummary> => ({
  main,
  holdout,
});

describe("guard", () => {
  const base = both(summary(counts(), { a: true, b: false }), summary(counts(), { c: true }));

  test("passes and says so when nothing is worse", () => {
    const r = guard(base, base, "x.json");
    expect(r.regressed).toBe(false);
    expect(r.text).toContain("ok: no score is worse");
  });

  test("a regression on the held-out corpus alone fails, and names the case", () => {
    const now = both(base.main, summary(counts({ realCaught: 29 }), { c: false }));
    const r = guard(base, now, "x.json");
    expect(r.regressed).toBe(true);
    expect(r.text).toMatch(/holdout\s+real caught\s+30\/32 \(94%\) -> 29\/32 \(91%\)\s+WORSE/);
    expect(r.text).toContain("holdout/c: now not flagged");
    expect(r.text).toContain("FAIL");
  });

  test("a regression on the main corpus fails too", () => {
    const now = both(summary(counts({ identicalFlagged: 1 })), base.holdout);
    expect(guard(base, now, "x.json").regressed).toBe(true);
  });
});

describe("verdictFlips", () => {
  test("only cases both files know, and only where the verdict moved", () => {
    expect(
      verdictFlips("main", { a: true, b: false, gone: true }, { a: false, b: false, fresh: true }),
    ).toEqual([{ corpus: "main", name: "a", flagged: false }]);
  });
});

describe("caseSetChanges", () => {
  test("names what was added and what was removed", () => {
    expect(caseSetChanges("holdout", { a: true, b: false }, { b: false, c: true })).toEqual({
      corpus: "holdout",
      added: ["c"],
      removed: ["a"],
    });
  });

  test("the guard says so when the case set moved", () => {
    const before = both(summary(counts(), { a: true }), summary(counts(), { c: true }));
    const after = both(summary(counts(), { a: true, n: false }), summary(counts(), {}));
    const text = guard(before, after, "x.json").text;
    expect(text).toContain("main: the case set differs");
    expect(text).toContain("added: n");
    expect(text).toContain("holdout: the case set differs");
    expect(text).toContain("removed: c");
  });
});

describe("results json", () => {
  test("round-trips what summarise wrote", () => {
    const file = {
      version: 1,
      date: "2026-10-20",
      pixelslashCommit: "abc",
      argos: { commit: "def", threshold: 0.5 },
      corpora: both(summary(counts(), { a: true }), summary(counts(), { c: false })),
    };
    expect(parseResults(JSON.stringify(file))).toEqual(file);
  });

  test("a file without a corpus is refused", () => {
    expect(() =>
      parseResults('{"version":1,"date":"d","pixelslashCommit":"c","corpora":{}}'),
    ).toThrow(/corpus/);
  });
});
