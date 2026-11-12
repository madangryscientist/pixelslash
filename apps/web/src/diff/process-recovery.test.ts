import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { finishRun } from "#/db/verdict";
import { builds, snapshots } from "#/db/schema";
import { usageCounts } from "#/db/usage";
import { markErrored } from "./build-writes";
import { STALE_PROCESSING_MS, processBuild } from "./process";
import { type Ctx, context, FINGERPRINT, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** Getting a build out of `errored` or a dead `processing` (ob 1545). */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** A main build, then a branch build that changed the shot: the one the recoveries re-diff. */
async function pair(ctx: Ctx, scoped = ctx.scoped) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  return upload(
    { ...ctx, scoped },
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
  );
}

/** Run A claimed the build at `old`; run B took it over at `newer` and finished with a verdict. */
async function takenOver() {
  const ctx = await context();
  const done = await pair(ctx);
  const old = new Date(Date.now() - STALE_PROCESSING_MS - 1000);
  const newer = new Date();
  await ctx.db
    .update(builds)
    .set({ status: "processing", processingStartedAt: newer })
    .where(eq(builds.id, done.id));
  expect(await finishRun(ctx.db, done.id, newer)).toBe("changes");
  const successor = await getBuild(ctx.db, ctx.projectId, done.id);
  expect(successor).toMatchObject({ status: "changes", error: null });
  return { ctx, done, old, newer, successor };
}

describe("recovery (ob 1545)", () => {
  test("a diff that errored is re-diffed to a real verdict, replacing what it stored", async () => {
    const ctx = await context();
    // R2 misses every read once: the first run cannot fetch the baseline and the build errors.
    const missing = { ...ctx.scoped, get: async () => null };
    const errored = await pair(ctx, missing);
    expect(errored.status).toBe("errored");
    expect(errored.error).toMatch(/missing from storage/);
    const before = await usageCounts(ctx.db);

    const result = await processBuild({ db: ctx.db, blobs: ctx.scoped }, errored);
    expect(result).toEqual({ status: "changes", error: null, unmeasured: 0 });
    const after = await getBuild(ctx.db, ctx.projectId, errored.id);
    expect(after).toMatchObject({ status: "changes", error: null });
    expect(await rows(ctx, after)).toHaveLength(1);
    expect(await onlyShot(ctx, after)).toMatchObject({ diffStatus: "changed" });
    expect(await usageCounts(ctx.db)).toEqual(before);
  });

  test("a build whose run died is taken over once it is older than the bound", async () => {
    const ctx = await context();
    const done = await pair(ctx);
    const shotBefore = await onlyShot(ctx, done);
    // The dead run's leavings: processing, claimed long ago, a shot it never reached and a stray marker.
    const claimedAt = new Date(Date.now() - STALE_PROCESSING_MS - 1000);
    await ctx.db
      .update(builds)
      .set({ status: "processing", processingStartedAt: claimedAt })
      .where(eq(builds.id, done.id));
    await ctx.db
      .update(snapshots)
      .set({ diffStatus: null, diffResult: null, diffKey: null, baselineKey: null })
      .where(eq(snapshots.buildId, done.id));
    await ctx.db.insert(snapshots).values({
      id: crypto.randomUUID(),
      buildId: done.id,
      name: "ghost",
      platform: "linux",
      browser: "chromium",
      viewport: "1280x720",
      theme: "light",
      envFingerprint: JSON.stringify(FINGERPRINT),
      imageKey: "builds/x/ghost.png",
      diffStatus: "removed",
    });
    const before = await usageCounts(ctx.db);

    const stuck = await getBuild(ctx.db, ctx.projectId, done.id);
    const result = await processBuild({ db: ctx.db, blobs: ctx.scoped }, stuck);
    expect(result.status).toBe("changes");
    const after = await rows(ctx, done);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: shotBefore.id,
      diffStatus: "changed",
      reviewState: "pending",
    });
    expect(after[0]?.diffResult?.changedPixels).toBeGreaterThan(0);
    expect(await usageCounts(ctx.db)).toEqual(before);
  });

  test("a build a live run holds is left alone", async () => {
    const ctx = await context();
    const done = await pair(ctx);
    await ctx.db
      .update(builds)
      .set({ status: "processing", processingStartedAt: new Date() })
      .where(eq(builds.id, done.id));
    await ctx.db
      .update(snapshots)
      .set({ diffStatus: null, diffResult: null })
      .where(eq(snapshots.buildId, done.id));

    const live = await getBuild(ctx.db, ctx.projectId, done.id);
    const result = await processBuild({ db: ctx.db, blobs: ctx.scoped }, live);
    expect(result).toEqual({ status: "processing", error: null, unmeasured: 0 });
    expect(await onlyShot(ctx, done)).toMatchObject({ diffStatus: null });
  });

  test("a build that is already diffed is not re-run: its review stays", async () => {
    const ctx = await context();
    const done = await pair(ctx);
    const reviewed = await onlyShot(ctx, done);
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: reviewed.id,
      state: "accepted",
      userId: ctx.userId,
    });
    const passed = await getBuild(ctx.db, ctx.projectId, done.id);
    const result = await processBuild({ db: ctx.db, blobs: ctx.scoped }, passed);
    expect(result).toEqual({ status: "passed", error: null, unmeasured: 0 });
    expect(await onlyShot(ctx, done)).toMatchObject({ reviewState: "accepted" });
  });

  describe("a run that outlived its claim (PS-392)", () => {
    test("its error does not turn the successor's verdict into errored", async () => {
      const { ctx, done, old, successor } = await takenOver();
      expect(
        await markErrored(ctx.db, successor, new Error("late"), { startedAt: old }),
      ).toBeNull();
      expect(await getBuild(ctx.db, ctx.projectId, done.id)).toMatchObject({
        status: "changes",
        error: null,
      });
    });

    test("nor does it end the successor's run while that run still holds the build", async () => {
      const { ctx, done, old, successor, newer } = await takenOver();
      await ctx.db.update(builds).set({ status: "processing" }).where(eq(builds.id, done.id));
      expect(
        await markErrored(ctx.db, successor, new Error("late"), { startedAt: old }),
      ).toBeNull();
      expect(await getBuild(ctx.db, ctx.projectId, done.id)).toMatchObject({
        status: "processing",
        processingStartedAt: newer,
        error: null,
      });
    });

    test("its verdict is not written: finishRun says so and the successor's status stands", async () => {
      const { ctx, done, old } = await takenOver();
      // The successor is running again (a re-diff of a shot) when the old run finishes.
      const again = new Date(Date.now() + 1000);
      await ctx.db
        .update(builds)
        .set({ status: "processing", processingStartedAt: again })
        .where(eq(builds.id, done.id));
      expect(await finishRun(ctx.db, done.id, old)).toBeNull();
      expect(await getBuild(ctx.db, ctx.projectId, done.id)).toMatchObject({
        status: "processing",
        processingStartedAt: again,
      });
      // The run that holds the claim still finishes it.
      expect(await finishRun(ctx.db, done.id, again)).toBe("changes");
    });

    test("the run that holds the claim ends the build errored and says what it stored", async () => {
      const ctx = await context();
      const done = await pair(ctx);
      const held = new Date();
      await ctx.db
        .update(builds)
        .set({ status: "processing", processingStartedAt: held })
        .where(eq(builds.id, done.id));
      const build = await getBuild(ctx.db, ctx.projectId, done.id);
      expect(await markErrored(ctx.db, build, new Error("boom"), { startedAt: held })).toBe("boom");
      expect(await getBuild(ctx.db, ctx.projectId, done.id)).toMatchObject({
        status: "errored",
        error: "boom",
      });
    });
  });
});
