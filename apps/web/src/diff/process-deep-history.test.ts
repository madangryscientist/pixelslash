import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A project that nx/turbo "affected" skipped for a long stretch of main (ob 1788): its last main
 * build sits far behind the merge-base, and the CLI sends up to 200 of the merge-base's
 * first-parent ancestors for the server to find it by.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const blue = shot({ blocks: [{ x: 4, y: 4, w: 24, h: 20, rgb: RED }] });

const MERGE_BASE = 1151;
/** Main's history below the merge-base: 1150 first (the nearest), 200 commits. */
const history = Array.from({ length: 200 }, (_, i) => sha(MERGE_BASE - 1 - i));
/** The commit `back` first-parent steps before the merge-base. */
const behind = (back: number) => sha(MERGE_BASE - back);

const onBranch = (png: typeof white) => ({
  branch: "feat/x",
  commit: sha(5000),
  mergeBase: sha(MERGE_BASE),
  ancestors: history,
  shots: [{ png }],
});

const main = (ctx: Ctx, commit: string, png: typeof white) =>
  upload(ctx, { branch: "main", commit, shots: [{ png }] });

describe("the baseline is found however long main skipped the project", () => {
  test("a main build 150 commits before the merge-base is the baseline", async () => {
    const ctx = await context();
    const old = await main(ctx, behind(150), white);
    const branch = await upload(ctx, onBranch(red));
    expect(await onlyShot(ctx, branch)).toMatchObject({
      diffStatus: "changed",
      baselineKey: (await onlyShot(ctx, old))?.imageKey,
    });
  });

  test("a main build newer than the merge-base is not used", async () => {
    const ctx = await context();
    const old = await main(ctx, behind(150), white);
    await main(ctx, sha(MERGE_BASE + 1), blue);
    const branch = await upload(ctx, onBranch(red));
    expect(await onlyShot(ctx, branch)).toMatchObject({
      diffStatus: "changed",
      baselineKey: (await onlyShot(ctx, old))?.imageKey,
    });
  });

  test("the nearest commit wins over a build created later at an older one", async () => {
    const ctx = await context();
    const near = await main(ctx, behind(10), white);
    await main(ctx, behind(150), blue);
    const branch = await upload(ctx, onBranch(red));
    expect(await onlyShot(ctx, branch)).toMatchObject({
      baselineKey: (await onlyShot(ctx, near))?.imageKey,
    });
  });

  test("past the 200th ancestor there is no baseline: the shot is new", async () => {
    const ctx = await context();
    await main(ctx, behind(201), white);
    const branch = await upload(ctx, onBranch(red));
    expect(await onlyShot(ctx, branch)).toMatchObject({ diffStatus: "new", baselineKey: null });
  });
});
