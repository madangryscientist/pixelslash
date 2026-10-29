import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { countBuilds } from "#/db/build-counts";
import { acceptAllSnapshots, reviewSnapshot } from "#/db/review";
import { type Ctx, context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A branch build's baseline is the branch's last build (ob 1712): a re-run shows only what moved
 * since, and a change still open there is carried, not re-measured against main or dropped.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const redder = shot({ blocks: [{ x: 4, y: 4, w: 24, h: 20, rgb: RED }] });

const onBranch = (commit: number, png: typeof white) => ({
  branch: "feat/x",
  commit: sha(commit),
  mergeBase: sha(1),
  shots: [{ png }],
});

async function decide(ctx: Ctx, snapshotId: string, state: "accepted" | "rejected") {
  return reviewSnapshot(ctx.db, {
    projectId: ctx.projectId,
    snapshotId,
    state,
    userId: ctx.userId,
  });
}

const status = async (ctx: Ctx, id: string) => (await getBuild(ctx.db, ctx.projectId, id)).status;

async function mainThenBranch() {
  const ctx = await context();
  const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  const first = await upload(ctx, onBranch(2, red));
  return { ctx, mainShot: await onlyShot(ctx, main), first, firstShot: await onlyShot(ctx, first) };
}

describe("a branch build's baseline is the branch's last build", () => {
  test("the same branch commit uploaded twice: the second build has 0 changed and still blocks", async () => {
    const { ctx, first, firstShot } = await mainThenBranch();
    expect(first.status).toBe("changes");

    const second = await upload(ctx, onBranch(2, red));
    const secondShot = await onlyShot(ctx, second);
    // Measured against build 1's shot, not main's: nothing moved. Build 1's change is undecided,
    // so this shot carries it and the build waits for the same decision.
    expect(secondShot).toMatchObject({
      diffStatus: "unchanged",
      baselineKey: firstShot?.imageKey,
      carriedFrom: firstShot?.id,
      reviewState: "pending",
    });
    expect(secondShot?.diffResult?.changedPixels).toBe(0);
    expect(second.status).toBe("changes");
    const counts = (await countBuilds(ctx.db, [second.id])).get(second.id);
    // Carried, and different from main: the build page counts it under Changed (PS-285).
    expect(counts).toMatchObject({ changed: 1, unchanged: 0, toReview: 1 });

    // A third run carries from the shot that measured the change, not from the carrier.
    const third = await upload(ctx, onBranch(2, red));
    expect(await onlyShot(ctx, third)).toMatchObject({
      diffStatus: "unchanged",
      carriedFrom: firstShot?.id,
    });
  });

  test("a decision on the carrier is the decision on the build it carries from", async () => {
    const { ctx, first } = await mainThenBranch();
    const second = await upload(ctx, onBranch(3, red));
    const secondShot = await onlyShot(ctx, second);
    expect(await decide(ctx, secondShot?.id ?? "", "accepted")).toBe("passed");
    expect(await onlyShot(ctx, first)).toMatchObject({ reviewState: "accepted" });
    expect(await status(ctx, first.id)).toBe("passed");
  });

  test("accepting the build that holds the change passes every build that carries it", async () => {
    const { ctx, first } = await mainThenBranch();
    const second = await upload(ctx, onBranch(3, red));
    const third = await upload(ctx, onBranch(4, red));
    await acceptAllSnapshots(ctx.db, {
      projectId: ctx.projectId,
      buildId: first.id,
      userId: ctx.userId,
    });
    expect(await status(ctx, second.id)).toBe("passed");
    expect(await status(ctx, third.id)).toBe("passed");
    expect(await onlyShot(ctx, third)).toMatchObject({ reviewState: "accepted" });
  });

  test("a rejection on a carrier fails every build of the change", async () => {
    const { ctx, first } = await mainThenBranch();
    const second = await upload(ctx, onBranch(3, red));
    const third = await upload(ctx, onBranch(4, red));
    expect(await decide(ctx, (await onlyShot(ctx, third))?.id ?? "", "rejected")).toBe("failed");
    expect(await status(ctx, first.id)).toBe("failed");
    expect(await status(ctx, second.id)).toBe("failed");
  });

  test("a shot accepted on build 1 is not pending on build 2 when its pixels are unchanged", async () => {
    const { ctx, firstShot } = await mainThenBranch();
    await decide(ctx, firstShot?.id ?? "", "accepted");
    const second = await upload(ctx, onBranch(3, red));
    expect(second.status).toBe("passed");
    expect(await onlyShot(ctx, second)).toMatchObject({
      diffStatus: "unchanged",
      baselineKey: firstShot?.imageKey,
      carriedFrom: null,
    });
  });

  test("a shot that moved past an open change is measured against the accepted shot", async () => {
    const { ctx, mainShot } = await mainThenBranch();
    const second = await upload(ctx, onBranch(3, redder));
    // Against build 1's unreviewed shot, accepting this would approve a change nobody saw.
    expect(await onlyShot(ctx, second)).toMatchObject({
      diffStatus: "changed",
      baselineKey: mainShot?.imageKey,
      carriedFrom: null,
    });
    expect(second.status).toBe("changes");
  });

  test("a shot that moved past an accepted one is measured against it", async () => {
    const { ctx, firstShot } = await mainThenBranch();
    await decide(ctx, firstShot?.id ?? "", "accepted");
    const second = await upload(ctx, onBranch(3, redder));
    expect(await onlyShot(ctx, second)).toMatchObject({
      diffStatus: "changed",
      baselineKey: firstShot?.imageKey,
    });
  });

  test("main is unchanged: each main build is auto-accepted and the next one's baseline", async () => {
    const ctx = await context();
    const one = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const two = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      ancestors: [sha(1)],
      shots: [{ png: red }],
    });
    expect(two.status).toBe("passed");
    expect(await onlyShot(ctx, two)).toMatchObject({
      diffStatus: "changed",
      baselineKey: (await onlyShot(ctx, one))?.imageKey,
      reviewState: "accepted",
      carriedFrom: null,
    });
  });
});
