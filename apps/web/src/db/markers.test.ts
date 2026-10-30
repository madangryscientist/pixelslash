import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { context, rows, sha, upload } from "#/diff/test-builds";
import { shot } from "#/diff/test-shots";
import { selectBaselines, snapshotKeyOf } from "./baselines";
import { createBuild, finaliseBuild, getBuild } from "./builds";
import { isMarker } from "./markers";
import { builds } from "./schema";
import { usageCounts } from "./usage";

/**
 * A removed marker (ob 1558) names the baseline build's blob without owning it: no reader may
 * count it, bill it, pick it as a baseline or mark it removed again.
 */

const white = shot();
const SHOT = { platform: "linux", browser: "chromium", viewport: "1280x720", theme: "light" };

describe("removed markers", () => {
  test("are never counted, billed, picked as a baseline or removed again", async () => {
    const ctx = await context();
    const first = await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [
        { name: "pricing", png: white },
        { name: "about", png: white },
      ],
    });
    const second = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      shots: [{ name: "pricing", png: white }],
    });
    const marker = (await rows(ctx, second)).find(isMarker);
    const gone = (await rows(ctx, first)).find((row) => row.name === "about");
    expect(marker?.name).toBe("about");
    expect(marker?.imageKey).toBe(gone?.imageKey);

    // A finalise retry counts the one upload, not the marker the diff wrote beside it.
    await expect(finaliseBuild(ctx.db, second, 1)).resolves.toMatchObject({ id: second.id });
    expect((await usageCounts(ctx.db)).snapshots).toBe(3);

    const id = await createBuild(ctx.db, ctx.projectId, {
      commitSha: sha(3),
      branch: "main",
      mergeBaseSha: null,
      ancestorShas: [],
      prNumber: null,
    });
    // `created_at` has whole seconds: order the three so the second is the branch's previous build.
    for (const [n, build] of [first, second].entries())
      await ctx.db
        .update(builds)
        .set({ createdAt: new Date(Date.now() - 60_000 + n * 1000) })
        .where(eq(builds.id, build.id));
    const third = await getBuild(ctx.db, ctx.projectId, id);
    const pricing = snapshotKeyOf({ name: "pricing", ...SHOT });
    const about = snapshotKeyOf({ name: "about", ...SHOT });

    // The branch's previous build holds `about` only as a marker: the pick falls through to the
    // shot that owns the image, never the marker.
    const back = await selectBaselines(ctx.db, third, new Set([pricing, about]));
    expect(back.byKey.get(about)?.shot.id).toBe(gone?.id);
    expect(back.removed).toEqual([]);

    // The previous build's marker is not a shot it holds, so it is not removed a second time.
    const again = await selectBaselines(ctx.db, third, new Set([pricing]));
    expect(again.removed).toEqual([]);
  });
});
