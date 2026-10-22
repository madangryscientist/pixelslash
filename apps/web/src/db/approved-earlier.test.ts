import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { acceptAllSnapshots, buildView, reviewSnapshot } from "./review";

/**
 * An unchanged shot whose change from the default branch was accepted on an earlier build of the
 * branch says so (ob 1722); nothing else gets the label.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

const onBranch = (commit: number, png: typeof white) => ({
  branch: "feat",
  commit: sha(commit),
  mergeBase: sha(1),
  shots: [{ png }],
});

async function accept(ctx: Ctx, snapshotId: string) {
  await reviewSnapshot(ctx.db, {
    projectId: ctx.projectId,
    snapshotId,
    state: "accepted",
    userId: ctx.userId,
  });
}

async function viewOf(ctx: Ctx, buildId: string) {
  const [only] = (await buildView(ctx.db, ctx.projectId, buildId)).snapshots;
  return only;
}

async function acceptedOnBuildOne() {
  const ctx = await context();
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  const first = await upload(ctx, onBranch(2, red));
  const firstShot = await onlyShot(ctx, first);
  if (!firstShot) throw new Error("no shot");
  await accept(ctx, firstShot.id);
  return { ctx, first, firstShot };
}

describe("approved earlier on this branch", () => {
  test("an accepted change uploaded again reads unchanged and names the build and reviewer", async () => {
    const { ctx, first, firstShot } = await acceptedOnBuildOne();
    const second = await upload(ctx, onBranch(3, red));
    const view = await viewOf(ctx, second.id);
    expect(second.status).toBe("passed");
    expect(view).toMatchObject({ diffStatus: "unchanged", carriedFrom: null });
    expect(view?.approvedEarlier).toMatchObject({
      snapshotId: firstShot.id,
      buildId: first.id,
      commitSha: sha(2),
      reviewedBy: "ada",
      defaultBranch: "main",
    });
    expect(view?.approvedEarlier?.reviewedAt).toBeInstanceOf(Date);
  });

  test("the approval is followed through an unchanged build in between, even one accepted wholesale", async () => {
    const { ctx, first } = await acceptedOnBuildOne();
    const second = await upload(ctx, onBranch(3, red));
    await acceptAllSnapshots(ctx.db, {
      projectId: ctx.projectId,
      buildId: second.id,
      userId: ctx.userId,
    });
    const third = await upload(ctx, onBranch(4, red));
    expect((await viewOf(ctx, third.id))?.approvedEarlier?.buildId).toBe(first.id);
  });

  test("a shot whose baseline is the default branch's gets no label", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(ctx, onBranch(2, white));
    expect(await viewOf(ctx, branch.id)).toMatchObject({
      diffStatus: "unchanged",
      approvedEarlier: null,
    });
  });

  test("no shot on the default branch gets the label", async () => {
    const ctx = await context();
    // Build 1's shot is new and auto-accepted on the same branch: off the default branch, that is an approval.
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const again = await upload(ctx, { branch: "main", commit: sha(2), shots: [{ png: white }] });
    expect(await viewOf(ctx, again.id)).toMatchObject({
      diffStatus: "unchanged",
      approvedEarlier: null,
    });
  });

  test("an open carried shot keeps carrying and blocking, with no label", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const first = await upload(ctx, onBranch(2, red));
    const second = await upload(ctx, onBranch(3, red));
    expect(second.status).toBe("changes");
    expect(await viewOf(ctx, second.id)).toMatchObject({
      carriedFrom: (await onlyShot(ctx, first))?.id,
      reviewState: "pending",
      approvedEarlier: null,
    });
  });

  test("a rejected change is not an approval", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const first = await upload(ctx, onBranch(2, red));
    const firstShot = await onlyShot(ctx, first);
    if (!firstShot) throw new Error("no shot");
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: firstShot.id,
      state: "rejected",
      userId: ctx.userId,
    });
    const second = await upload(ctx, onBranch(3, red));
    expect((await viewOf(ctx, second.id))?.approvedEarlier).toBeNull();
  });
});
