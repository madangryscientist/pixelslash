import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { branchView } from "#/db/branch-view";
import { reviewSnapshot } from "#/db/review";
import { awaitsDecision, groupOf } from "#/lib/snapshot-groups";
import { builds } from "#/db/schema";
import {
  type BuildSpec,
  type Ctx,
  type Shot,
  context,
  rows,
  sha,
  upload as send,
} from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A branch build measured against main as well as against its own baseline (ob 1723): the branch
 * page's final review reads the stored result; nothing is diffed when it is viewed.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

const shots = (a: Shot["png"], b: Shot["png"]): Shot[] => [
  { name: "a", png: a },
  { name: "b", png: b },
];

let clock = 0;

/**
 * Upload, then date the build a second after the last one: the clock is in seconds, and builds made
 * in the same second would leave which one is the branch's newest to their random ids.
 */
async function upload(ctx: Ctx, spec: BuildSpec) {
  const build = await send(ctx, spec);
  clock += 1;
  await ctx.db
    .update(builds)
    .set({ createdAt: new Date(Date.now() - 600_000 + clock * 1000) })
    .where(eq(builds.id, build.id));
  return build;
}

const onFeat = (commit: number, list: Shot[]) => ({
  branch: "feat",
  commit: sha(commit),
  mergeBase: sha(1),
  shots: list,
});

async function decide(ctx: Ctx, snapshotId: string, state: "accepted" | "rejected") {
  return reviewSnapshot(ctx.db, {
    projectId: ctx.projectId,
    snapshotId,
    state,
    userId: ctx.userId,
  });
}

async function byName(ctx: Ctx, build: Parameters<typeof rows>[1]) {
  return new Map((await rows(ctx, build)).map((row) => [row.name, row]));
}

/** Main with A and B; feat build 1 changes A, which is accepted; build 2 changes B. */
async function twoBuilds() {
  const ctx = await context();
  const mainBuild = await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: shots(white, white),
  });
  const first = await upload(ctx, onFeat(2, shots(red, white)));
  const a = (await byName(ctx, first)).get("a");
  await decide(ctx, a?.id ?? "", "accepted");
  const second = await upload(ctx, onFeat(3, shots(red, red)));
  return { ctx, mainBuild, first, second };
}

const view = async (ctx: Ctx) => branchView(ctx.db, ctx.projectId, "feat");

describe("a branch build against main", () => {
  test("against main shows A and B; since last build shows B changed and A approved earlier", async () => {
    const { ctx, second } = await twoBuilds();
    const branch = await view(ctx);
    expect(branch.build.id).toBe(second.id);
    expect(branch.buildCount).toBe(2);

    const main = new Map(branch.againstMain.map((s) => [s.name, s]));
    expect(main.get("a")).toMatchObject({ mainDiffStatus: "changed", mainGroup: "accepted" });
    expect(main.get("a")?.decision).toMatchObject({ state: "accepted", earlier: true });
    expect(main.get("b")).toMatchObject({ mainDiffStatus: "changed", mainGroup: "waiting" });

    const since = new Map(branch.snapshots.map((s) => [s.name, s]));
    expect(groupOf(since.get("b") ?? { diffStatus: null, rebaselineNeeded: false })).toBe(
      "changed",
    );
    expect(since.get("a")).toMatchObject({ diffStatus: "unchanged" });
    expect(since.get("a")?.approvedEarlier).not.toBeNull();
  });

  test("against main is measured from main's accepted shot, never the branch's own", async () => {
    const { ctx, mainBuild, second } = await twoBuilds();
    const onMain = (await byName(ctx, mainBuild)).get("a");
    const a = (await byName(ctx, second)).get("a");
    // A's own baseline is build 1's shot; against main it is main's, measured and stored as a result.
    expect(a?.baselineKey).not.toBe(onMain?.imageKey);
    expect(a?.mainBaselineKey).toBe(onMain?.imageKey);
    expect(a?.mainDiffStatus).toBe("changed");
    expect(a?.mainDiffResult?.changedPixels).toBeGreaterThan(0);
    // No overlay is stored against main: the page draws its boxes from the result.
    expect(await ctx.scoped.get(`${a?.imageKey.replace(/\.png$/, "")}.main.diff.png`)).toBeNull();
  });

  test("the first branch build reuses its own diff: its baseline already is main's", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: shots(white, white) });
    const first = await upload(ctx, onFeat(2, shots(red, white)));
    const a = (await byName(ctx, first)).get("a");
    expect(a).toMatchObject({ diffStatus: "changed", mainDiffStatus: "changed" });
    expect(a?.mainBaselineKey).toBe(a?.baselineKey);
    expect(a?.mainDiffResult).toEqual(a?.diffResult);
  });

  test("a default-branch build is not measured against main", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: shots(white, white) });
    const next = await upload(ctx, { branch: "main", commit: sha(2), shots: shots(red, white) });
    for (const row of await rows(ctx, next)) {
      expect(row).toMatchObject({
        mainBaselineKey: null,
        mainDiffStatus: null,
        mainDiffResult: null,
      });
    }
  });

  test("a shot with no accepted shot on main at the merge-base is new against main", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ name: "a", png: white }] });
    const first = await upload(ctx, onFeat(2, shots(white, red)));
    const b = (await byName(ctx, first)).get("b");
    expect(b).toMatchObject({ mainDiffStatus: "new", mainBaselineKey: null });
    const main = (await view(ctx)).againstMain.find((s) => s.name === "b");
    expect(main).toMatchObject({ mainGroup: "waiting" });
  });

  test("re-uploading the same commit leaves both views unchanged", async () => {
    const { ctx } = await twoBuilds();
    const before = await view(ctx);
    await upload(ctx, onFeat(3, shots(red, red)));
    const after = await view(ctx);
    const read = (v: typeof before) =>
      v.againstMain
        .map((s) =>
          [s.name, s.mainDiffStatus, s.mainGroup, s.mainDiffResult?.changedPixels].join(" "),
        )
        .toSorted((a, b) => a.localeCompare(b));
    expect(read(after)).toEqual(read(before));
    // Since the last build, nothing moved (1712): B is no change since build 2 and still carries
    // its open change, so the same shot waits for the same decision.
    const waiting = (v: typeof before) => v.snapshots.filter(awaitsDecision).map((s) => s.name);
    expect(waiting(after)).toEqual(waiting(before));
    expect(after.build.status).toBe(before.build.status);
  });

  test("a branch with no builds is not found", async () => {
    const ctx = await context();
    await expect(view(ctx)).rejects.toThrow("branch not found");
  });
});
