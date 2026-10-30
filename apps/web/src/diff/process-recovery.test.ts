import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { builds, snapshots } from "#/db/schema";
import { usageCounts } from "#/db/usage";
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

/** A clock that advances `step` ms per reading, so each shot appears to cost a fixed time. */
const slow = (step: number) => {
  let t = 0;
  return () => (t += step);
};

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

  test("a build the Worker ceiling stopped is resumed on retry, and the retry gives the verdict", async () => {
    const ctx = await context();
    const named = (png: typeof white) => ["a", "b", "c"].map((name) => ({ name, png }));
    await upload(ctx, { branch: "main", commit: sha(1), shots: named(white) });
    const stopped = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: named(red) },
      { now: slow(4000) },
    );
    expect(stopped.status).toBe("errored");
    expect(stopped.error).toMatch(/diff ceiling: measured 2 of 3 shots \(1 left\)/);
    expect((await rows(ctx, stopped)).filter((r) => r.diffStatus === null)).toHaveLength(1);

    // The same slow clock: the one shot left fits, and the build gets its verdict.
    const result = await processBuild({ db: ctx.db, blobs: ctx.scoped, now: slow(4000) }, stopped);
    expect(result).toEqual({ status: "changes", error: null, unmeasured: 0 });
    expect(await rows(ctx, stopped)).toHaveLength(3);
  });
});
