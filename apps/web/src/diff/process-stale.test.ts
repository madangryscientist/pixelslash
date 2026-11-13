import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { countBuilds } from "#/db/build-counts";
import { builds, snapshots } from "#/db/schema";
import { projectStale } from "#/db/stale";
import { reviewSnapshot } from "#/db/review";
import { awaitsReason } from "#/lib/snapshot-groups";
import { FINGERPRINT, context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A build is processed after a person accepted a web change: its native shot of that key, found
 * unchanged, is left pending as stale instead of passing on its own. Who is stale and when it
 * clears is `db/stale.test.ts`; this is that rule reached through `processBuild`.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const android = {
  renderer: { platform: "android", browser: "Pixel 8 API 35" },
  fingerprint: { ...FINGERPRINT, platform: "android", device: "Pixel 8 API 35", scale: "3" },
};
const NAME = "Button/md-primary";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

test("an unchanged native shot of a key whose web change a person accepted waits for a review, stale", async () => {
  const ctx = await context();
  const main = await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: NAME, png: white },
      { name: NAME, png: white, ...android },
    ],
  });
  expect(main.status).toBe("passed");
  expect(await projectStale(ctx.db, ctx.projectId)).toEqual([]);

  // Build and review times are whole seconds, so the order is set, not left to the clock.
  await ctx.db
    .update(builds)
    .set({ createdAt: hoursAgo(3) })
    .where(eq(builds.id, main.id));
  const web = await upload(ctx, {
    branch: "work",
    commit: sha(2),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: [{ name: NAME, png: red }],
  });
  const changed = await onlyShot(ctx, web);
  expect(changed.diffStatus).toBe("changed");
  await ctx.db
    .update(builds)
    .set({ createdAt: hoursAgo(2) })
    .where(eq(builds.id, web.id));
  await reviewSnapshot(ctx.db, {
    projectId: ctx.projectId,
    snapshotId: changed.id,
    state: "accepted",
    userId: ctx.userId,
  });
  await ctx.db
    .update(snapshots)
    .set({ reviewedAt: hoursAgo(1) })
    .where(eq(snapshots.id, changed.id));
  expect(await projectStale(ctx.db, ctx.projectId)).toHaveLength(1);

  const native = await upload(ctx, {
    branch: "native",
    commit: sha(3),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: [{ name: NAME, png: white, ...android }],
  });
  const left = await onlyShot(ctx, native);
  expect(left).toMatchObject({
    platform: "android",
    diffStatus: "unchanged",
    reviewState: "pending",
  });
  expect(left.staleOf).toBe(changed.id);
  expect(awaitsReason(left)).toBe("stale");
  expect(native.status).toBe("changes");
  expect((await countBuilds(ctx.db, [native.id])).get(native.id)?.toReview).toBe(1);

  // A person accepting it ends the staleness.
  await reviewSnapshot(ctx.db, {
    projectId: ctx.projectId,
    snapshotId: left.id,
    state: "accepted",
    userId: ctx.userId,
  });
  expect(await projectStale(ctx.db, ctx.projectId)).toEqual([]);
});
