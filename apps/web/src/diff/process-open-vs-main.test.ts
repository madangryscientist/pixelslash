import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { type Build, getBuild } from "#/db/builds";
import { setGithubRepo } from "#/db/orgs";
import { reviewSnapshot } from "#/db/review";
import { builds, snapshots } from "#/db/schema";
import { fakeGithub } from "#/github/test-github";
import { type CheckRunBody, syncCheckRuns } from "#/github/check-run";
import { rediffShots } from "./rerun";
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
 * A branch build never ends `passed` while a shot that differs from main is still undecided
 * (PS-284). On the LAN an open change was dropped by a build that measured nothing (before
 * PS-282), the build after it ended `passed` carrying nothing, and the next one took that as its
 * baseline: 1,223 shots unchanged against it, yet five changed and 26 new against main.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** `home` is on main as it is; `about` differs from main; `pricing` is not on main. */
const featShots = (): Shot[] => [
  { name: "home", png: white },
  { name: "about", png: red },
  { name: "pricing", png: red },
];

let clock = 0;

/** Upload, then date the build a second after the last one: the branch's newest build must be unambiguous. */
async function upload(ctx: Ctx, spec: BuildSpec) {
  const build = await send(ctx, spec);
  clock += 1;
  await ctx.db
    .update(builds)
    .set({ createdAt: new Date(Date.now() - 600_000 + clock * 1000) })
    .where(eq(builds.id, build.id));
  return build;
}

const onFeat = (commit: number, list: Shot[] = featShots()): BuildSpec => ({
  branch: "feat",
  commit: sha(commit),
  mergeBase: sha(1),
  shots: list,
});

async function onMain() {
  const ctx = await context();
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "home", png: white },
      { name: "about", png: white },
    ],
  });
  return ctx;
}

const byName = async (ctx: Ctx, build: Build) =>
  Object.fromEntries((await rows(ctx, build)).map((row) => [row.name, row]));

/**
 * The state the LAN builds were left in before PS-282: shots that were never measured against
 * anything (build 6940ccb7), or that read "no change" against one of those and carried nothing
 * (4f012650).
 */
async function leftPassed(ctx: Ctx, build: Build, unmeasured: boolean) {
  await ctx.db
    .update(snapshots)
    .set({
      carriedFrom: null,
      reviewState: "pending",
      ...(unmeasured
        ? { diffStatus: null, diffResult: null, rebaselineNeeded: true, baselineSnapshotId: null }
        : { diffStatus: "unchanged" as const }),
      mainDiffStatus: null,
      mainDiffResult: null,
      mainBaselineKey: null,
      mainDiffKey: null,
    })
    .where(eq(snapshots.buildId, build.id));
  await ctx.db.update(builds).set({ status: "passed" }).where(eq(builds.id, build.id));
}

/** The chain from the ticket: an open change, a build that measured nothing, one that passed on it, a new one. */
async function theChain() {
  const ctx = await onMain();
  const first = await upload(ctx, onFeat(2));
  expect(first.status).toBe("changes");
  const measuredNothing = await upload(ctx, onFeat(3));
  await leftPassed(ctx, measuredNothing, true);
  const passedOnIt = await upload(ctx, onFeat(4));
  await leftPassed(ctx, passedOnIt, false);
  // `leftPassed` wrote a baseline-less state; the third build compared with the second's shots.
  const secondShots = await rows(ctx, measuredNothing);
  for (const row of await rows(ctx, passedOnIt)) {
    const base = secondShots.find((s) => s.name === row.name);
    await ctx.db
      .update(snapshots)
      .set({ baselineSnapshotId: base?.id ?? null })
      .where(eq(snapshots.id, row.id));
  }
  return { ctx, first, measuredNothing, passedOnIt };
}

async function decide(ctx: Ctx, snapshotId: string, state: "accepted" | "rejected") {
  return reviewSnapshot(ctx.db, {
    projectId: ctx.projectId,
    snapshotId,
    state,
    userId: ctx.userId,
  });
}

/** The check run the build gets on GitHub, as it is sent. */
async function checkRunOf(ctx: Ctx, buildId: string): Promise<CheckRunBody> {
  await setGithubRepo(ctx.db, ctx.userId, ctx.projectId, "acme/web");
  const github = fakeGithub();
  await syncCheckRuns(
    { db: ctx.db, app: github.app({ timeoutMs: 50 }), token: null, publicUrl: "https://ps.test/" },
    [buildId],
  );
  const body = github.checkRunCalls().at(-1);
  if (!body) throw new Error("no check run was sent");
  return JSON.parse(body.raw);
}

describe("open changes against main (PS-284)", () => {
  test("a build after the chain ends at changes, and the check run names the changed and new shots", async () => {
    const { ctx, passedOnIt } = await theChain();
    expect((await getBuild(ctx.db, ctx.projectId, passedOnIt.id)).status).toBe("passed");

    const next = await upload(ctx, onFeat(5));
    const shots = await byName(ctx, next);
    // Against its previous build every shot is unchanged, which is the whole of rule 1.
    expect(Object.values(shots).map((s) => s.diffStatus)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(shots["about"]).toMatchObject({ mainDiffStatus: "changed", reviewState: "pending" });
    expect(shots["pricing"]).toMatchObject({ mainDiffStatus: "new", reviewState: "pending" });
    expect(shots["about"]?.carriedFrom).not.toBeNull();
    expect(shots["pricing"]?.carriedFrom).not.toBeNull();
    expect(shots["home"]?.carriedFrom).toBeNull();
    expect(next.status).toBe("changes");

    const run = await checkRunOf(ctx, next.id);
    expect(run.conclusion).toBe("failure");
    expect(run.output.title).toBe("2 changes to review");
    expect(run.output.summary).toContain("Waiting for review: 1 changed shot and 1 new shot.");
    expect(run.output.summary).toContain("- Changed: about (1280x720, light)");
    expect(run.output.summary).toContain("- New: pricing (1280x720, light)");
    expect(run.output.summary).not.toContain("home");
  });

  test("accepting the open shots turns the build and the check run to passed", async () => {
    const { ctx } = await theChain();
    const next = await upload(ctx, onFeat(5));
    expect(next.status).toBe("changes");
    const shots = await byName(ctx, next);
    await decide(ctx, shots["about"]?.id ?? "", "accepted");
    expect(await decide(ctx, shots["pricing"]?.id ?? "", "accepted")).toBe("passed");

    expect((await getBuild(ctx.db, ctx.projectId, next.id)).status).toBe("passed");
    const run = await checkRunOf(ctx, next.id);
    expect(run.conclusion).toBe("success");
    expect(run.output.summary).not.toContain("Waiting for review");

    // The decision holds for the build after it: the shots are accepted, not open again.
    const after = await upload(ctx, onFeat(6));
    expect(after.status).toBe("passed");
  });

  test("a branch build unchanged against main and its previous build still passes", async () => {
    const ctx = await onMain();
    const same: Shot[] = [
      { name: "home", png: white },
      { name: "about", png: white },
    ];
    const first = await upload(ctx, onFeat(2, same));
    const second = await upload(ctx, onFeat(3, same));
    expect(first.status).toBe("passed");
    expect(second.status).toBe("passed");
    const shots = await rows(ctx, second);
    expect(shots.every((s) => s.mainDiffStatus === "unchanged" && s.carriedFrom === null)).toBe(
      true,
    );
  });

  test("a change accepted on the branch, then unchanged, stays decided and passes", async () => {
    const ctx = await onMain();
    const withChange: Shot[] = [
      { name: "home", png: white },
      { name: "about", png: red },
    ];
    const first = await upload(ctx, onFeat(2, withChange));
    expect(first.status).toBe("changes");
    const shots = await byName(ctx, first);
    expect(await decide(ctx, shots["about"]?.id ?? "", "accepted")).toBe("passed");
    const second = await upload(ctx, onFeat(3, withChange));
    expect(second.status).toBe("passed");
    expect((await byName(ctx, second))["about"]).toMatchObject({
      diffStatus: "unchanged",
      carriedFrom: null,
    });
  });

  test("re-running a shot of a build that passed on open changes corrects its verdict, no upload", async () => {
    const { ctx } = await theChain();
    // cd6e40b5 as the LAN holds it: unchanged against its baseline, differing from main, `passed`.
    const next = await upload(ctx, onFeat(5));
    expect(next.status).toBe("changes");
    await ctx.db.update(snapshots).set({ carriedFrom: null }).where(eq(snapshots.buildId, next.id));
    await ctx.db.update(builds).set({ status: "passed" }).where(eq(builds.id, next.id));
    const before = await byName(ctx, next);
    expect(before["about"]?.mainDiffStatus).toBe("changed");

    const done = await rediffShots(
      { db: ctx.db, blobs: ctx.scoped },
      await getBuild(ctx.db, ctx.projectId, next.id),
      [before["home"]?.id ?? ""],
    );
    expect(done.status).toBe("changes");
    const after = await byName(ctx, next);
    expect(after["about"]?.carriedFrom).not.toBeNull();
    expect(after["pricing"]?.carriedFrom).not.toBeNull();
    expect(after["home"]?.carriedFrom).toBeNull();
    // Nothing else was rewritten: the stored results are the ones the build had.
    expect(after["about"]?.mainDiffStatus).toBe("changed");
    expect(after["about"]?.diffStatus).toBe("unchanged");
  });
});
