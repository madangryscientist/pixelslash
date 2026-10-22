import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { groupOf } from "#/lib/snapshot-groups";
import { createBuild } from "./builds";
import { NotFoundError } from "./db";
import { builds as buildRows } from "./schema";
import { listBuilds } from "./build-list";
import { NotReviewableError, acceptAllSnapshots, buildView, reviewSnapshot } from "./review";
import { isFirstBuild } from "./first-build";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/** A main build plus a feature build that changes one shot, adds one and drops one. */
async function twoBuilds() {
  const ctx = await context();
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot() },
      { name: "contact", png: shot() },
    ],
  });
  // `created_at` has second resolution, so two uploads in one second tie on the clock. The list
  // orders by that clock; the test moves the first build a minute back to model real arrivals.
  await ctx.db
    .update(buildRows)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(buildRows.commitSha, sha(1)));
  const feature = await upload(ctx, {
    branch: "feature",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot({ blocks: [block] }) },
      { name: "pricing", png: shot() },
    ],
  });
  return { ctx, feature };
}

describe("the review model reads", () => {
  test("a build is grouped changed / new / removed / unchanged, and the walk order follows", async () => {
    const { ctx, feature } = await twoBuilds();
    expect(feature.status).toBe("changes");
    const view = await buildView(ctx.db, ctx.projectId, feature.id);
    expect(view.snapshots.map((s) => `${s.name}:${s.diffStatus}:${s.reviewState}`)).toEqual([
      "about:changed:pending",
      "pricing:new:pending",
      "contact:removed:pending",
      "home:unchanged:pending",
    ]);
    const about = view.snapshots[0];
    expect(about?.diffResult?.regions.length).toBeGreaterThan(0);
    expect(about?.diffResult?.regions[0]?.kind).toBe("change");
  });

  test("the project page lists builds newest first with counts", async () => {
    const { ctx } = await twoBuilds();
    const builds = await listBuilds(ctx.db, ctx.projectId);
    expect(builds.map((b) => b.branch)).toEqual(["feature", "main"]);
    expect(builds[0]?.counts).toMatchObject({
      changed: 1,
      new: 1,
      removed: 1,
      unchanged: 1,
      pending: 4,
    });
    expect(builds[1]?.counts).toMatchObject({ new: 3, changed: 0, pending: 0 });
  });

  test("a shot of an errored build is not measured, never a re-baseline", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ name: "home", png: shot() }] });
    const errored = await upload(
      ctx,
      {
        branch: "feat/x",
        commit: sha(2),
        mergeBase: sha(1),
        shots: [{ name: "home", png: shot({ blocks: [block] }) }],
      },
      {
        now: () => {
          throw new Error("isolate died");
        },
      },
    );
    expect(errored.status).toBe("errored");
    const [summary] = (await listBuilds(ctx.db, ctx.projectId)).filter(
      (b) => b.branch === "feat/x",
    );
    expect(summary?.counts).toMatchObject({ unmeasured: 1, rebaseline: 0, changed: 0 });
    const view = await buildView(ctx.db, ctx.projectId, errored.id);
    expect(view.snapshots.map((s) => groupOf(s))).toEqual(["unmeasured"]);
  });

  test("a build after an errored first build is the first baseline (ob 1718)", async () => {
    const ctx = await context();
    const errored = await upload(
      ctx,
      { branch: "main", commit: sha(1), shots: [{ name: "home", png: shot() }] },
      {
        now: () => {
          throw new Error("isolate died");
        },
      },
    );
    expect(errored.status).toBe("errored");
    await ctx.db
      .update(buildRows)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(buildRows.commitSha, sha(1)));
    const next = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      shots: [{ name: "home", png: shot() }],
    });
    expect(await isFirstBuild(ctx.db, next)).toBe(true);
    const view = await buildView(ctx.db, ctx.projectId, next.id);
    expect(view.snapshots.map((s) => s.diffStatus)).toEqual(["new"]);
  });

  test("a build after an accepted earlier build is not the first baseline (ob 1718)", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ name: "home", png: shot() }] });
    await ctx.db
      .update(buildRows)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(buildRows.commitSha, sha(1)));
    const next = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      shots: [{ name: "home", png: shot() }],
    });
    expect(await isFirstBuild(ctx.db, next)).toBe(false);
  });

  test("accepting the changed shot records the reviewer and passes the build", async () => {
    const { ctx, feature } = await twoBuilds();
    const view = await buildView(ctx.db, ctx.projectId, feature.id);
    const about = view.snapshots.find((s) => s.name === "about");
    if (!about) throw new Error("no about shot");
    const status = await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: about.id,
      state: "accepted",
      userId: ctx.userId,
    });
    expect(status).toBe("passed");
    const after = await buildView(ctx.db, ctx.projectId, feature.id);
    const reviewed = after.snapshots.find((s) => s.id === about.id);
    expect(reviewed?.reviewState).toBe("accepted");
    expect(reviewed?.reviewedBy).toBe("ada");
    expect(reviewed?.reviewedAt).toBeInstanceOf(Date);
  });

  test("a rejection fails the build, and accept-all cannot undo it", async () => {
    const { ctx, feature } = await twoBuilds();
    const view = await buildView(ctx.db, ctx.projectId, feature.id);
    const about = view.snapshots.find((s) => s.name === "about");
    if (!about) throw new Error("no about shot");
    const status = await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: about.id,
      state: "rejected",
      userId: ctx.userId,
    });
    expect(status).toBe("failed");
    await expect(
      acceptAllSnapshots(ctx.db, {
        projectId: ctx.projectId,
        buildId: feature.id,
        userId: ctx.userId,
      }),
    ).rejects.toThrow(NotReviewableError);
    const after = await buildView(ctx.db, ctx.projectId, feature.id);
    expect(after.build.status).toBe("failed");
  });

  test("accept all records every shot and passes the build", async () => {
    const { ctx, feature } = await twoBuilds();
    const status = await acceptAllSnapshots(ctx.db, {
      projectId: ctx.projectId,
      buildId: feature.id,
      userId: ctx.userId,
    });
    expect(status).toBe("passed");
    const after = await buildView(ctx.db, ctx.projectId, feature.id);
    expect(after.build.status).toBe("passed");
    for (const snapshot of after.snapshots) {
      expect(snapshot.reviewState).toBe("accepted");
      expect(snapshot.reviewedBy).toBe("ada");
    }
  });

  test("another project's build and snapshot are 404, and an open build is not reviewable", async () => {
    const { ctx, feature } = await twoBuilds();
    await expect(buildView(ctx.db, ctx.other.project.id, feature.id)).rejects.toThrow(
      NotFoundError,
    );
    expect(await listBuilds(ctx.db, ctx.other.project.id)).toEqual([]);

    const view = await buildView(ctx.db, ctx.projectId, feature.id);
    const about = view.snapshots.find((s) => s.name === "about");
    if (!about) throw new Error("no about shot");
    await expect(
      reviewSnapshot(ctx.db, {
        projectId: ctx.other.project.id,
        snapshotId: about.id,
        state: "accepted",
        userId: ctx.userId,
      }),
    ).rejects.toThrow(NotFoundError);

    const open = await createBuild(ctx.db, ctx.projectId, {
      commitSha: sha(9),
      branch: "feature",
      mergeBaseSha: null,
      ancestorShas: [],
      prNumber: null,
    });
    await expect(
      acceptAllSnapshots(ctx.db, {
        projectId: ctx.projectId,
        buildId: open,
        userId: ctx.userId,
      }),
    ).rejects.toThrow(NotReviewableError);
  });
});
