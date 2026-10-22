import { describe, expect, test } from "vitest";
import type { SnapshotView } from "#/db/review";
import type { DiffResult } from "#/db/schema";
import { againstMainLines, branchShot, mainSummary, sinceLastBuildLines } from "./branch-review";

const head = { id: "b3", commitSha: "9c2e41a0000000000000000000000000000000000" };

const result = (over: Partial<DiffResult> = {}): DiffResult => ({
  changedPixels: 2140,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [
    { kind: "change", x: 0, y: 0, w: 10, h: 10, changedPixels: 100, antialiasedPixels: 0 },
    { kind: "change", x: 20, y: 20, w: 10, h: 10, changedPixels: 100, antialiasedPixels: 0 },
  ],
  width: 1280,
  height: 640,
  mainWidth: 1280,
  mainHeight: 640,
  branchWidth: 1280,
  branchHeight: 640,
  sizeChanged: false,
  ...over,
});

const view = (name: string, over: Partial<SnapshotView> = {}): SnapshotView => ({
  id: name,
  name,
  platform: "linux",
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
  tags: [],
  diffStatus: "unchanged",
  reviewState: "pending",
  reviewedBy: null,
  reviewedAt: null,
  diffOptions: {},
  ignore: [],
  imageKey: `${name}.png`,
  baselineKey: null,
  diffKey: null,
  diffResult: null,
  rebaselineNeeded: false,
  carriedFrom: null,
  carriedFromBuild: null,
  approvedEarlier: null,
  measuredBy: null,
  engineVersion: null,
  diffError: null,
  flakeId: null,
  flakyPolicy: null,
  mainBaselineKey: null,
  mainDiffKey: null,
  mainDiffStatus: null,
  mainDiffResult: null,
  changeNote: null,
  createdAt: new Date(0),
  ...over,
});

const shots = [
  view("about", {
    mainDiffStatus: "changed",
    mainDiffResult: result({ changedPixels: 100, regions: [result().regions[0]!] }),
    approvedEarlier: {
      snapshotId: "a1",
      buildId: "b1",
      commitSha: "61f0c170000000000000000000000000000000000",
      reviewedBy: "jacobus",
      reviewedAt: new Date(0),
      defaultBranch: "main",
    },
  }),
  view("hero", {
    diffStatus: "changed",
    diffResult: result(),
    mainDiffStatus: "changed",
    mainDiffResult: result({
      changedPixels: 812,
      regions: [result().regions[0]!],
      sizeChanged: true,
      mainHeight: 640,
      branchHeight: 700,
    }),
    changeNote: "the banner is 60 px taller",
  }),
  view("checkout", {
    diffStatus: "changed",
    diffResult: result(),
    mainDiffStatus: "changed",
    mainDiffResult: result(),
    reviewState: "rejected",
    reviewedBy: "sam",
  }),
  view("cart-empty", { diffStatus: "new", mainDiffStatus: "new" }),
  view("footer", { mainDiffStatus: "unchanged" }),
  view("legacy"),
].map((shot) => branchShot(shot, head));

describe("against main", () => {
  test("lists exactly the shots that differ from main, rejected, then waiting, then accepted", () => {
    const lines = againstMainLines(shots);
    expect(lines.map((line) => line.name)).toEqual(["checkout", "hero", "cart-empty", "about"]);
    expect(lines.map((line) => line.state)).toEqual([
      "rejected by sam on build 9c2e41a",
      "waiting",
      "waiting",
      "accepted by jacobus on build 61f0c17 · unchanged since",
    ]);
  });

  test("a line with a judge's note leads with it; the measured facts always follow", () => {
    const [, hero, cart, about] = againstMainLines(shots);
    expect(hero).toMatchObject({
      note: "the banner is 60 px taller",
      facts: "size changed 1280×640 → 1280×700; overlap compared, 812 px in 1 box",
    });
    expect(cart).toMatchObject({ note: null, facts: "new: nothing to compare with" });
    expect(about).toMatchObject({ note: null, facts: "100 px in 1 box" });
  });

  test("a shot never measured against main is not counted and withholds ready", () => {
    const summary = mainSummary(shots, true);
    expect(summary).toEqual({
      changed: 4,
      accepted: 1,
      waiting: 2,
      rejected: 1,
      unmeasured: 1,
      ready: false,
    });
  });

  test("ready only when nothing waits, nothing was rejected and every shot was measured", () => {
    const accepted = shots
      .filter((shot) => shot.name !== "legacy")
      .map((shot) => branchShot({ ...shot, reviewState: "accepted", reviewedBy: "sam" }, head));
    expect(mainSummary(accepted, true).ready).toBe(true);
    expect(mainSummary(accepted, false).ready).toBe(false);
  });
});

describe("since the last build", () => {
  test("lists exactly the head build's changed, new and removed shots, in that order", () => {
    const lines = sinceLastBuildLines([
      ...shots,
      view("gone", { diffStatus: "removed" }),
      view("approved", { diffStatus: "unchanged", approvedEarlier: shots[0]!.approvedEarlier }),
    ]);
    expect(lines.map((line) => [line.name, line.facts, line.state])).toEqual([
      ["hero", "2,140 px in 2 boxes", "not reviewed"],
      ["checkout", "2,140 px in 2 boxes", "rejected by sam"],
      ["cart-empty", "new: nothing to compare with", "not reviewed"],
      ["gone", "removed: in the baseline only", "not reviewed"],
    ]);
    expect(lines[0]?.note).toBe("the banner is 60 px taller");
    expect(lines[1]?.note).toBeNull();
  });
});
