import { describe, expect, test } from "vitest";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { NotFoundError } from "./db";
import { flagSnapshot, listFlags, snapshotFlags, withdrawFlag } from "./flags";
import { buildView, reviewSnapshot } from "./review";
import { members } from "./schema";
import { signInGithubUser } from "./users";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/** A main build and a feature build whose one shot changed. */
async function changedShot() {
  const ctx = await context();
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ name: "home", png: shot() }] });
  const feature = await upload(ctx, {
    branch: "feature",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [{ name: "home", png: shot({ blocks: [block] }) }],
  });
  const view = await buildView(ctx.db, ctx.projectId, feature.id);
  const home = view.snapshots[0];
  if (!home) throw new Error("no home shot");
  const at = { userId: ctx.userId, projectId: ctx.projectId, snapshotId: home.id };
  return { ctx, feature, home, at };
}

describe("detection flags", () => {
  test("create, edit and withdraw: one flag per user per snapshot", async () => {
    const { ctx, home, at } = await changedShot();
    const rect = { x: 8, y: 8, width: 12, height: 12 };
    await flagSnapshot(ctx.db, { ...at, kind: "false_positive", note: "font wobble", rect });
    expect(await snapshotFlags(ctx.db, at)).toMatchObject([
      { kind: "false_positive", note: "font wobble", rect, by: "ada", mine: true },
    ]);

    await flagSnapshot(ctx.db, { ...at, kind: "missed", note: null, rect: null });
    const [edited, ...rest] = await listFlags(ctx.db, ctx.userId, ctx.projectId);
    expect(rest).toEqual([]);
    expect(edited).toMatchObject({ kind: "missed", note: null, rect: null });
    // What the diff measured travels with it, read from the shot.
    expect(edited?.measured).toEqual({
      diffStatus: "changed",
      changedPixels: home.diffResult?.changedPixels,
      diffOptions: {},
    });

    await withdrawFlag(ctx.db, at);
    expect(await snapshotFlags(ctx.db, at)).toEqual([]);
    await withdrawFlag(ctx.db, at);
  });

  test("a second reviewer's flag sits beside the first, and is not theirs to edit", async () => {
    const { ctx, at } = await changedShot();
    const bob = await signInGithubUser(ctx.db, {
      githubId: 2,
      login: "bob",
      name: null,
      avatarUrl: null,
    });
    await ctx.db.insert(members).values({ orgId: ctx.orgId, userId: bob.id });
    await flagSnapshot(ctx.db, { ...at, kind: "false_positive", note: "aa", rect: null });
    await flagSnapshot(ctx.db, { ...at, userId: bob.id, kind: "missed", note: null, rect: null });
    await withdrawFlag(ctx.db, { ...at, userId: bob.id });
    expect(await snapshotFlags(ctx.db, { ...at, userId: bob.id })).toMatchObject([
      { by: "ada", mine: false },
    ]);
  });

  test("another org's snapshot is a 404, by project and by membership", async () => {
    const { ctx, at } = await changedShot();
    const flag = { kind: "missed", note: null, rect: null } as const;
    await expect(
      flagSnapshot(ctx.db, { ...at, ...flag, projectId: ctx.other.project.id }),
    ).rejects.toThrow(NotFoundError);
    const eve = await signInGithubUser(ctx.db, {
      githubId: 3,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await expect(flagSnapshot(ctx.db, { ...at, ...flag, userId: eve.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(withdrawFlag(ctx.db, { ...at, userId: eve.id })).rejects.toThrow(NotFoundError);
    await expect(snapshotFlags(ctx.db, { ...at, userId: eve.id })).rejects.toThrow(NotFoundError);
    await expect(listFlags(ctx.db, eve.id, ctx.projectId)).rejects.toThrow(NotFoundError);
  });

  test("flagging leaves review state and the build verdict as they were, and accepting keeps the flag", async () => {
    const { ctx, feature, at } = await changedShot();
    const before = await buildView(ctx.db, ctx.projectId, feature.id);
    await flagSnapshot(ctx.db, { ...at, kind: "false_positive", note: null, rect: null });
    const after = await buildView(ctx.db, ctx.projectId, feature.id);
    expect(after.build.status).toBe("changes");
    expect(after.build.status).toBe(before.build.status);
    expect(after.snapshots.map((s) => [s.reviewState, s.diffStatus, s.diffKey])).toEqual(
      before.snapshots.map((s) => [s.reviewState, s.diffStatus, s.diffKey]),
    );
    await reviewSnapshot(ctx.db, { ...at, state: "accepted" });
    expect(await snapshotFlags(ctx.db, at)).toMatchObject([{ kind: "false_positive" }]);
  });

  test("the export lists exactly the project's flags, with the blob keys and the rect", async () => {
    const { ctx, feature, home, at } = await changedShot();
    const rect = { x: 0, y: 0, width: 4, height: 4 };
    await flagSnapshot(ctx.db, { ...at, kind: "false_positive", note: "jitter", rect });
    // A flag in the other project of the same user must not appear.
    const otherCtx = { ...ctx, projectId: ctx.other.project.id };
    const otherBuild = await upload(otherCtx, {
      branch: "main",
      commit: sha(3),
      shots: [{ name: "home", png: shot() }],
    });
    const [otherShot] = (await buildView(ctx.db, otherCtx.projectId, otherBuild.id)).snapshots;
    if (!otherShot) throw new Error("no other shot");
    await flagSnapshot(ctx.db, {
      userId: ctx.userId,
      projectId: otherCtx.projectId,
      snapshotId: otherShot.id,
      kind: "missed",
      note: null,
      rect: null,
    });

    const flags = await listFlags(ctx.db, ctx.userId, ctx.projectId);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      kind: "false_positive",
      note: "jitter",
      rect,
      snapshot: { id: home.id, name: "home" },
      build: { id: feature.id, branch: "feature" },
      keys: { image: home.imageKey, baseline: home.baselineKey, diff: home.diffKey },
    });
    expect(flags[0]?.keys.baseline).toBeTruthy();
    expect(flags[0]?.keys.diff).toBeTruthy();
  });
});
