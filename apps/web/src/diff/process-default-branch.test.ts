import { describe, expect, test } from "vitest";
import { setDefaultBranch } from "#/db/orgs";
import { context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** The branch that auto-accepts is the project's, not a hard-coded `main` (ob 1559). */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

describe("the project's default branch", () => {
  test("a project on master auto-accepts master, which baselines branch builds; main is a branch", async () => {
    const ctx = await context();
    await setDefaultBranch(ctx.db, ctx.userId, ctx.projectId, "master");
    const master = await upload(ctx, { branch: "master", commit: sha(1), shots: [{ png: white }] });
    expect(master.status).toBe("passed");
    expect((await onlyShot(ctx, master))?.reviewState).toBe("accepted");

    // A merge to master that changes the shot is accepted too, and is the next baseline.
    const merged = await upload(ctx, {
      branch: "master",
      commit: sha(2),
      ancestors: [sha(1)],
      shots: [{ png: red }],
    });
    expect(merged.status).toBe("passed");
    const mergedShot = await onlyShot(ctx, merged);
    expect(mergedShot).toMatchObject({ diffStatus: "changed", reviewState: "accepted" });

    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(3),
      mergeBase: sha(2),
      shots: [{ png: white }],
    });
    expect(branch.status).toBe("changes");
    expect(await onlyShot(ctx, branch)).toMatchObject({
      diffStatus: "changed",
      baselineKey: mergedShot?.imageKey,
      reviewState: "pending",
    });

    // `main` is now just another branch: its changed shot waits for review.
    const main = await upload(ctx, {
      branch: "main",
      commit: sha(4),
      mergeBase: sha(2),
      shots: [{ png: white }],
    });
    expect(main.status).toBe("changes");
    expect((await onlyShot(ctx, main))?.reviewState).toBe("pending");
  });
});
