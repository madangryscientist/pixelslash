import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DEFAULT_TIMEOUT_MS } from "../src/impl/invoke.ts";
import { DEFAULT_RUNS, parseArgs } from "../src/perf/args.ts";
import { STEP_IDS } from "../src/perf/steps.ts";
import {
  compare,
  median,
  percentile,
  REGRESSION_PCT,
  regressionLine,
  summarise,
} from "../src/perf/stats.ts";
import { pickBase, run } from "../src/perf/worktree.ts";

describe("median and p95", () => {
  test("the median of an odd and an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("p95 is the nearest rank, and one sample is its own p95", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(summarise([5, 1, 3])).toEqual({ n: 3, median: 3, p95: 5 });
  });

  test("no samples is an error, not a zero", () => {
    expect(() => median([])).toThrow("no samples");
  });
});

const at = (m: number) => ({ n: 5, median: m, p95: m });

describe("compare", () => {
  test("the limit is a head median more than 25% above the base", () => {
    expect(REGRESSION_PCT).toBe(25);
    expect(compare("s", at(100), at(125)).regressed).toBe(false);
    expect(compare("s", at(100), at(125.1)).regressed).toBe(true);
    expect(compare("s", at(100), at(60)).changePct).toBeCloseTo(-40);
  });

  test("the failing line names the step and both medians", () => {
    const line = regressionLine(compare("diff-phone", at(31.5), at(332.2)));
    expect(line).toContain("diff-phone");
    expect(line).toContain("332.2 ms");
    expect(line).toContain("31.5 ms");
  });
});

describe("parseArgs", () => {
  test("no arguments: every step, the default rounds, no base given", () => {
    expect(parseArgs([])).toEqual({
      check: false,
      base: null,
      runs: DEFAULT_RUNS,
      only: [...STEP_IDS],
      impls: [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      decode: null,
    });
  });

  test("the flags", () => {
    expect(
      parseArgs(["--check", "--base", "v1", "--runs", "3", "--only", "capture,diff-long"]),
    ).toEqual({
      check: true,
      base: "v1",
      runs: 3,
      only: ["diff-long", "capture"],
      impls: [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      decode: null,
    });
  });

  test("a bad flag, rounds or step is refused", () => {
    expect(() => parseArgs(["--nope"])).toThrow("unknown argument");
    expect(() => parseArgs(["--runs", "0"])).toThrow("whole number");
    expect(() => parseArgs(["--base"])).toThrow("needs a value");
    expect(() => parseArgs(["--only", "diff-phone,x"])).toThrow("unknown step: x");
  });
});

describe("pickBase", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-perf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("no origin/main and no main is no base; a given ref is used or refused", async () => {
    await run(["git", "init", "-q", "-b", "work"], dir);
    await run(
      [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ],
      dir,
    );
    expect(await pickBase(dir, null)).toBeNull();
    const sha = (await run(["git", "rev-parse", "HEAD"], dir)).out;
    expect(await pickBase(dir, "work")).toBe(sha);
    await expect(pickBase(dir, "nope")).rejects.toThrow("no such ref");
    await run(["git", "branch", "main"], dir);
    expect(await pickBase(dir, null)).toBe(sha);
  });
});
