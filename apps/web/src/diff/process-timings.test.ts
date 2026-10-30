import { diffPngs } from "@hackcove/pixelslash-engine/diff";
import { describe, expect, test } from "vitest";
import { stubModel, twoChanges, withModel } from "#/ai/explain-test-kit";
import { getBuild } from "#/db/builds";
import type { BlobStore } from "#/storage/blobs";
import { processBuild } from "./process";
import { rerunShots } from "./rerun";
import { type Ctx, context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** What a diff run and the explain queue record on the build (ob 1792). */

const failing: typeof diffPngs = () => {
  throw new Error("PNG does not decode");
};

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** A clock only a blob write advances, by `cost` ms: a diff of one changed shot then takes `cost`. */
function timed(ctx: Ctx, cost: number) {
  let t = 0;
  const blobs: BlobStore = {
    ...ctx.scoped,
    put: async (key, body, type) => {
      t += cost;
      await ctx.scoped.put(key, body, type);
    },
  };
  return { blobs, now: () => t };
}

async function mainThenBranch(ctx: Ctx, extra: Parameters<typeof upload>[2] = {}) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  return upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
    extra,
  );
}

describe("server timings", () => {
  test("a processed build stores its wait, its diff and its end", async () => {
    const ctx = await context();
    const clock = timed(ctx, 400);
    const before = Date.now();
    const build = await mainThenBranch(ctx, clock);
    expect(build.status).toBe("changes");
    expect(build.diffMs).toBe(400);
    expect(build.queueMs).toBeGreaterThanOrEqual(0);
    expect(build.rerun).toBe(false);
    expect(build.finishedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(build.finishedAt?.getTime()).toBeGreaterThanOrEqual(
      build.processingStartedAt?.getTime() ?? Infinity,
    );
    // No model: nothing was explained or summarised, and the columns say so rather than 0.
    expect(build.explainMs).toBeNull();
    expect(build.summaryMs).toBeNull();
  });

  test("an errored build keeps the numbers of what ran, and its end", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
      { diff: failing },
    );
    expect(build.status).toBe("errored");
    expect(build.finishedAt).not.toBeNull();
    expect(build.diffMs).not.toBeNull();
    expect(build.queueMs).not.toBeNull();
  });

  test("a resumed run is a re-run: no queue wait, and it is marked", async () => {
    const ctx = await context();
    const clock = timed(ctx, 10_000);
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: ["a", "b", "c", "d"].map((name) => ({ name, png: white })),
    });
    const errored = await upload(
      ctx,
      {
        branch: "feat/x",
        commit: sha(2),
        mergeBase: sha(1),
        shots: ["a", "b", "c", "d"].map((name) => ({ name, png: red })),
      },
      clock,
    );
    expect(errored.status).toBe("errored");
    expect(errored.rerun).toBe(false);
    expect(errored.queueMs).not.toBeNull();
    await processBuild({ db: ctx.db, blobs: clock.blobs, now: clock.now }, errored);
    const after = await getBuild(ctx.db, ctx.projectId, errored.id);
    expect(after.rerun).toBe(true);
    expect(after.queueMs).toBeNull();
    expect(after.diffMs).toBeGreaterThan(0);
  });

  test("a shot re-run is a re-run too", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const errored = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
      { diff: failing },
    );
    expect(errored).toMatchObject({ status: "errored", rerun: false });
    await rerunShots({ db: ctx.db, blobs: ctx.scoped }, errored, null);
    const after = await getBuild(ctx.db, ctx.projectId, errored.id);
    expect(after).toMatchObject({ status: "changes", rerun: true, queueMs: null });
    expect(after.finishedAt).not.toBeNull();
  });

  test("the explanations and the summary are timed by the queue, and move the end", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    // Every reading of the clock is 100 ms later than the last.
    let t = 0;
    const now = () => (t += 100);
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
      { modelFetch: stubModel().modelFetch, now },
    );
    expect(build.aiSummary).not.toBeNull();
    expect(build.explainMs).toBeGreaterThan(0);
    expect(build.summaryMs).toBeGreaterThan(0);
    expect(build.finishedAt?.getTime()).toBeGreaterThanOrEqual(
      build.processingStartedAt?.getTime() ?? Infinity,
    );
  });

  test("a new run clears the last run's AI numbers", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    let t = 0;
    const now = () => (t += 100);
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
      { modelFetch: stubModel().modelFetch, now },
    );
    expect(build.explainMs).toBeGreaterThan(0);
    // A re-run with no queue and no model: the numbers belong to this run, so they are empty.
    const picked = await onlyShot(ctx, build);
    await rerunShots({ db: ctx.db, blobs: ctx.scoped, now }, build, picked.id);
    const after = await getBuild(ctx.db, ctx.projectId, build.id);
    expect(after.explainMs).toBeNull();
    expect(after.summaryMs).toBeNull();
    expect(after.rerun).toBe(true);
  });
});
