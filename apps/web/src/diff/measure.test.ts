import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { context, onlyShot, sha, upload } from "./test-builds";
import { type Block, RED, shot } from "./test-shots";

/**
 * What the server records from the engine's measurement (ob 1470): the boxes, both sizes on a
 * size change, the ignore areas it was given, and the stored options. None of this is
 * re-implemented here; the tests pin the wiring.
 */

const W = 200;
const H = 100;
const blank = shot({ width: W, height: H });

describe("changed regions", () => {
  test("two separate changes give two boxes that match the paint", async () => {
    const ctx = await context();
    const blocks: Block[] = [
      { x: 10, y: 10, w: 20, h: 10, rgb: RED },
      { x: 150, y: 70, w: 24, h: 12, rgb: [10, 40, 220] },
    ];
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: blank }] });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: shot({ width: W, height: H, blocks }) }],
    });
    const held = await onlyShot(ctx, branch);
    expect(held.diffStatus).toBe("changed");
    const boxes = held.diffResult?.regions.filter((r) => r.kind === "change") ?? [];
    expect(boxes).toHaveLength(2);
    const sorted = boxes.toSorted((a, b) => a.y - b.y);
    expect(sorted[0]).toMatchObject({ x: 10, y: 10, w: 20, h: 10 });
    expect(sorted[1]).toMatchObject({ x: 150, y: 70, w: 24, h: 12 });
  });

  test("a size change is changed, measures only the overlap, and records both sizes", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: blank }] });
    // The page grew 40px and the new strip is a different colour: nothing in the overlap moved.
    const taller = shot({
      width: W,
      height: H + 40,
      blocks: [{ x: 0, y: H, w: W, h: 40, rgb: RED }],
    });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: taller }],
    });
    const held = await onlyShot(ctx, branch);
    expect(held.diffStatus).toBe("changed");
    expect(held.diffResult).toMatchObject({
      sizeChanged: true,
      width: W,
      height: H,
      mainWidth: W,
      mainHeight: H,
      branchWidth: W,
      branchHeight: H + 40,
      changedPixels: 0,
      regions: [],
    });
  });
});

describe("stored options and ignore areas", () => {
  test("the ignore areas sent at upload are skipped and counted", async () => {
    const ctx = await context();
    const block = { x: 20, y: 20, w: 10, h: 10, rgb: RED };
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: blank }] });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [
        {
          png: shot({ width: W, height: H, blocks: [block] }),
          ignore: [{ x: 20, y: 20, width: 10, height: 10 }],
        },
      ],
    });
    const held = await onlyShot(ctx, branch);
    expect(held.diffStatus).toBe("unchanged");
    expect(held.diffResult).toMatchObject({
      ignoredPixels: 100,
      changedPixels: 0,
      ignored: [{ x: 20, y: 20, width: 10, height: 10 }],
    });
  });

  test("the snapshot's stored diff options are applied, not the engine's defaults", async () => {
    const ctx = await context();
    const block = { x: 20, y: 20, w: 10, h: 10, rgb: RED };
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: blank }] });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [
        { png: shot({ width: W, height: H, blocks: [block] }), diff: { minChangedPixels: 500 } },
      ],
    });
    const held = await onlyShot(ctx, branch);
    // 100 changed pixels, recorded, but under the stored floor: not a change, so it does not block.
    expect(held.diffStatus).toBe("unchanged");
    expect(held.diffResult?.changedPixels).toBe(100);
    expect(branch.status).toBe("passed");
  });
});

describe("failures", () => {
  test("a missing baseline image errors the build rather than inventing a verdict", async () => {
    const ctx = await context();
    const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: blank }] });
    const held = await onlyShot(ctx, main);
    await ctx.scoped.delete(held.imageKey);
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      // Not the baseline's bytes: identical ones are settled without reading it (ob 1948).
      shots: [
        { png: shot({ width: W, height: H, blocks: [{ x: 1, y: 1, w: 2, h: 2, rgb: RED }] }) },
      ],
    });
    expect(branch.status).toBe("errored");
    expect(branch.error).toContain("missing from storage");

    // Its undiffed shots must not be reviewable into a `passed` that claims they were measured.
    const errored = await onlyShot(ctx, branch);
    await expect(
      reviewSnapshot(ctx.db, {
        projectId: ctx.projectId,
        snapshotId: errored.id,
        state: "accepted",
        userId: ctx.userId,
      }),
    ).rejects.toThrow("only a diffed build can be reviewed");
    expect((await getBuild(ctx.db, ctx.projectId, branch.id)).status).toBe("errored");
  });
});
