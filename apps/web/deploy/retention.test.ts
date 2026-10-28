import { join } from "node:path";
import { expect, test } from "vitest";
import type { RetentionPlan } from "../src/db/retention";
import { listing, parseArgs } from "./retention";

const parse = (argv: string[], env: Record<string, string> = {}) => parseArgs(argv, env);

test("retention off with no days: it refuses instead of picking a window", () => {
  expect(() => parse([])).toThrow(/retention is off/);
  expect(() => parse([], { PIXELSLASH_RETENTION_DAYS: "soon" })).toThrow(/retention is off/);
});

test("it is a dry run unless --apply is passed", () => {
  expect(parse(["--days", "30"]).apply).toBe(false);
  expect(parse(["--days", "30", "--dry-run"]).apply).toBe(false);
  expect(parse(["--days", "30", "--apply"]).apply).toBe(true);
  expect(() => parse(["--days", "30", "--apply", "--dry-run"])).toThrow(/contradict/);
});

test("the days come from the flag, then the environment", () => {
  expect(parse([], { PIXELSLASH_RETENTION_DAYS: "14" }).days).toBe(14);
  expect(parse(["--days", "7"], { PIXELSLASH_RETENTION_DAYS: "14" }).days).toBe(7);
  expect(() => parse(["--days", "0"])).toThrow(/whole number/);
  expect(() => parse(["--days"])).toThrow(/needs a value/);
});

test("the limit and the state directory", () => {
  const args = parse(["--days", "30", "--limit", "5"], { PIXELSLASH_DATA_DIR: "/data" });
  expect(args.limit).toBe(5);
  expect(args.persistTo).toBe(join("/data", "state/v3"));
  expect(parse(["--days", "30", "--persist-to", "/x/y"]).persistTo).toBe("/x/y");
  expect(() => parse(["--days", "30", "--limit", "many"])).toThrow(/whole number/);
  expect(() => parse(["--days", "30", "--delete"])).toThrow(/unknown argument/);
});

test("the listing names each build with its blobs and bytes, then what was kept", () => {
  const plan: RetentionPlan = {
    days: 30,
    cutoff: new Date("2026-09-28T00:00:00Z"),
    expired: [
      {
        id: "b1",
        projectId: "p",
        orgId: "o",
        branch: "feature",
        createdAt: new Date("2026-09-01T10:00:00Z"),
        blobs: [
          { key: "builds/b1/a.png", size: 2048 },
          { key: "builds/b1/b.png", size: 1024 },
        ],
      },
    ],
    keptReferenced: ["b0"],
  };
  expect(listing(plan)).toEqual([
    "cutoff 2026-09-28T00:00:00.000Z (30 days)",
    "b1  2026-09-01  feature  2 blobs  3.0 KiB",
    "1 past the window kept: a build that stays points at them",
  ]);
});
