import { describe, expect, test } from "vitest";
import { context, onlyShot, sha, upload } from "#/diff/test-builds";
import { shot } from "#/diff/test-shots";
import { selectBaselines, snapshotKeyOf } from "./baselines";
import { branchView } from "./branch-view";
import { listBuilds } from "./build-list";
import { createBuild } from "./builds";

/**
 * Builds order by when they arrived, to the millisecond: two builds of one project sent back to
 * back by one server are not left to their random ids for which is the newest or which may be the
 * other's baseline. No wait and no back-dated row here.
 */

const KEY = snapshotKeyOf({
  name: "home",
  platform: "linux",
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
});

describe("build arrival order", () => {
  test("two builds sent back to back: the second is the newest and the newer baseline", async () => {
    const ctx = await context();
    const first = await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ name: "home", png: shot() }],
    });
    const second = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      shots: [{ name: "home", png: shot() }],
    });
    expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());

    expect((await listBuilds(ctx.db, ctx.projectId)).map((b) => b.id)).toEqual([
      second.id,
      first.id,
    ]);
    const branch = await branchView(ctx.db, ctx.projectId, "main");
    expect(branch.build.id).toBe(second.id);
    expect(branch.previous?.id).toBe(first.id);

    // A third build's baseline is the newer of the two candidates.
    const third = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      shots: [{ name: "home", png: shot() }],
    });
    const picked = await selectBaselines(ctx.db, third, new Set([KEY]));
    expect(picked.byKey.get(KEY)?.shot.id).toBe((await onlyShot(ctx, second)).id);
    // And a build that arrived later is never an earlier build's baseline (`lte` on the clock).
    const before = await selectBaselines(ctx.db, first, new Set([KEY]));
    expect(before.byKey.size).toBe(0);
  });

  test("builds created in one tight loop each get their own millisecond", async () => {
    const ctx = await context();
    const ids: string[] = [];
    for (let n = 0; n < 50; n++)
      ids.push(
        await createBuild(ctx.db, ctx.projectId, {
          commitSha: sha(n + 1),
          branch: "main",
          mergeBaseSha: null,
          ancestorShas: [],
          prNumber: null,
          brief: null,
        }),
      );
    const listed = await listBuilds(ctx.db, ctx.projectId);
    expect(listed.map((b) => b.id)).toEqual(ids.toReversed());
    expect(new Set(listed.map((b) => b.createdAt.getTime())).size).toBe(ids.length);
  });
});
