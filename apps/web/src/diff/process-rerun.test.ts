import { diffPngs } from "@hackcove/pixelslash-engine/diff";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { builds, projects, snapshots } from "#/db/schema";
import { NoRecoveryError } from "./claim";
import { RerunError, rerunShots } from "./rerun";
import { type Ctx, context, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** Partial re-runs (ob 1738): only the errored or picked shots are measured again. */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const names = Array.from({ length: 10 }, (_, i) => `s${i}`);

/** The engine's diff, counting its calls; the first `failing` of them throw. */
function counted(failing = 0) {
  const seen = { calls: 0 };
  const diff: typeof diffPngs = (...args) => {
    seen.calls++;
    if (seen.calls <= failing) throw new Error("PNG does not decode");
    return diffPngs(...args);
  };
  return { seen, diff };
}

/** Main with ten white shots, then a branch build of ten red ones, diffed with `diff`. */
async function tenShots(ctx: Ctx, diff?: typeof diffPngs) {
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: names.map((name) => ({ name, png: white })),
  });
  return upload(
    ctx,
    {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: names.map((name) => ({ name, png: red })),
    },
    { diff },
  );
}

const deps = (ctx: Ctx, diff?: typeof diffPngs) => ({ db: ctx.db, blobs: ctx.scoped, diff });

describe("partial re-runs (ob 1738)", () => {
  test("a build with two errored shots of ten re-diffs only those two", async () => {
    const ctx = await context();
    const errored = await tenShots(ctx, counted(2).diff);
    expect(errored.status).toBe("errored");
    expect(errored.error).toMatch(/^2 of 10 shots could not be measured/);
    const failed = (await rows(ctx, errored)).filter((r) => r.diffError !== null);
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.diffStatus === null)).toBe(true);

    const { seen, diff } = counted();
    const result = await rerunShots(deps(ctx, diff), errored, null);
    expect(result).toEqual({ status: "changes", error: null, unmeasured: 0 });
    expect(seen.calls).toBe(2);
    const after = await rows(ctx, errored);
    expect(after.every((r) => r.diffStatus === "changed" && r.diffError === null)).toBe(true);
    expect(await getBuild(ctx.db, ctx.projectId, errored.id)).toMatchObject({
      status: "changes",
      error: null,
    });
  });

  test("a shot that errors again leaves the build errored, naming it", async () => {
    const ctx = await context();
    const errored = await tenShots(ctx, counted(2).diff);
    const result = await rerunShots(deps(ctx, counted(1).diff), errored, null);
    expect(result.status).toBe("errored");
    expect(result.error).toMatch(/^1 of 10 shots could not be measured/);
    expect((await rows(ctx, errored)).filter((r) => r.diffError !== null)).toHaveLength(1);
  });

  test("a picked shot whose re-diff fails loses its review and errors the build", async () => {
    const ctx = await context();
    const build = await tenShots(ctx);
    const [first] = await rows(ctx, build);
    if (!first) throw new Error("no shots");
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      snapshotId: first.id,
      state: "rejected",
    });
    const failed = await getBuild(ctx.db, ctx.projectId, build.id);
    const result = await rerunShots(deps(ctx, counted(1).diff), failed, first.id);
    expect(result.status).toBe("errored");
    expect((await rows(ctx, build)).find((r) => r.id === first.id)).toMatchObject({
      diffStatus: null,
      reviewState: "pending",
      reviewedBy: null,
    });
  });

  test("a picked shot measured the same keeps its review; the others are not measured", async () => {
    const ctx = await context();
    const build = await tenShots(ctx);
    const [first, second] = await rows(ctx, build);
    if (!first || !second) throw new Error("no shots");
    const review = { projectId: ctx.projectId, userId: ctx.userId };
    await reviewSnapshot(ctx.db, { ...review, snapshotId: second.id, state: "accepted" });
    await reviewSnapshot(ctx.db, { ...review, snapshotId: first.id, state: "rejected" });
    const failedBuild = await getBuild(ctx.db, ctx.projectId, build.id);
    expect(failedBuild.status).toBe("failed");

    const { seen, diff } = counted();
    const result = await rerunShots(deps(ctx, diff), failedBuild, first.id);
    expect(seen.calls).toBe(1);
    expect(result.status).toBe("failed");
    const after = await rows(ctx, build);
    expect(after.find((r) => r.id === first.id)).toMatchObject({
      reviewState: "rejected",
      reviewedBy: ctx.userId,
    });
    expect(after.find((r) => r.id === second.id)?.reviewState).toBe("accepted");
  });

  test("a picked shot whose result moved goes back to pending", async () => {
    const ctx = await context();
    const build = await tenShots(ctx);
    const [first] = await rows(ctx, build);
    if (!first?.diffResult) throw new Error("no measured shot");
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      snapshotId: first.id,
      state: "rejected",
    });
    // A result the engine would not give these PNGs now: the re-run measures a different one.
    await ctx.db
      .update(snapshots)
      .set({ diffResult: { ...first.diffResult, changedPixels: 1 } })
      .where(eq(snapshots.id, first.id));
    const failed = await getBuild(ctx.db, ctx.projectId, build.id);

    const result = await rerunShots(deps(ctx), failed, first.id);
    expect(result.status).toBe("changes");
    const after = (await rows(ctx, build)).find((r) => r.id === first.id);
    expect(after).toMatchObject({ reviewState: "pending", reviewedBy: null });
  });

  test("a CI-diff project is refused, and nothing is measured", async () => {
    const ctx = await context();
    const errored = await tenShots(ctx, counted(2).diff);
    await ctx.db.update(projects).set({ diffLocation: "ci" }).where(eq(projects.id, ctx.projectId));
    const { seen, diff } = counted();
    await expect(rerunShots(deps(ctx, diff), errored, null)).rejects.toBeInstanceOf(
      NoRecoveryError,
    );
    expect(seen.calls).toBe(0);
  });

  test("a shot not in the build, a build with nothing errored and a held build are refused", async () => {
    const ctx = await context();
    const build = await tenShots(ctx);
    await expect(rerunShots(deps(ctx), build, "nope")).rejects.toBeInstanceOf(RerunError);
    await expect(rerunShots(deps(ctx), build, null)).rejects.toThrow(/nothing errored/);

    await ctx.db
      .update(builds)
      .set({ status: "processing", processingStartedAt: new Date() })
      .where(eq(builds.id, build.id));
    const held = await getBuild(ctx.db, ctx.projectId, build.id);
    const [first] = await rows(ctx, build);
    if (!first) throw new Error("no shots");
    await expect(rerunShots(deps(ctx), held, first.id)).rejects.toThrow(/a diff run holds it/);
  });
});
