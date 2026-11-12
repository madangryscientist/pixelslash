import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { context, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { DAY_MS } from "#/lib/retention";
import { orgSweepBlobs } from "#/storage/blobs";
import type { Build } from "./builds";
import { sweepRetention } from "./retention";
import { builds } from "./schema";

/** A shot stored by hash (PS-424) reads another build's PNG: the sweep must see that edge. */

const NOW = new Date("2026-10-28T12:00:00Z");

test("a shot stored by hash keeps the build that holds its PNG, and both go together", async () => {
  const ctx = await context();
  const png = shot({ blocks: [{ x: 8, y: 8, w: 12, h: 12, rgb: RED }] });
  const source = await upload(ctx, {
    branch: "feature-a",
    commit: sha(2),
    shots: [{ png }],
  });
  const byHash = await upload(ctx, {
    branch: "feature-b",
    commit: sha(3),
    shots: [{ png, byHash: true }],
  });
  expect((await onlyShot(ctx, byHash)).imageKey).toBe((await onlyShot(ctx, source)).imageKey);

  const age = (build: Build, days: number) =>
    ctx.db
      .update(builds)
      .set({ createdAt: new Date(NOW.getTime() - days * DAY_MS) })
      .where(eq(builds.id, build.id));
  const sweep = () =>
    sweepRetention(ctx.db, (orgId) => orgSweepBlobs(ctx.blobs.store, orgId), {
      days: 30,
      now: NOW,
      dryRun: false,
    });

  await age(source, 40);
  await age(byHash, 1);
  const kept = await sweep();
  expect(kept.plan.expired).toEqual([]);
  expect(kept.plan.keptReferenced).toEqual([source.id]);
  expect(kept.result?.buildsDeleted).toBe(0);
  expect(ctx.blobs.data.size).toBeGreaterThan(0);

  // Once the build that reads it ages out too, both go and no blob is left.
  await age(byHash, 40);
  const gone = await sweep();
  expect(gone.result?.buildsDeleted).toBe(2);
  expect(ctx.blobs.data.size).toBe(0);
});
