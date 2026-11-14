import { describe, expect, test } from "vitest";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { afterDecision, buildView, decideShot } from "./review";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/**
 * A main build plus a feature build whose "about" and "pricing" shots change and "home" does not.
 * `between` runs one statement just before the next read of the build's shots.
 */
async function changedBuild() {
  let pending: string | null = null;
  const ctx = await context((query, exec) => {
    if (pending === null || !query.includes('from "snapshots" left join')) return;
    exec(pending);
    pending = null;
  });
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: ["home", "about", "pricing"].map((name) => ({ name, png: shot() })),
  });
  const feature = await upload(ctx, {
    branch: "feature",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot({ blocks: [block] }) },
      { name: "pricing", png: shot({ blocks: [block] }) },
    ],
  });
  const view = await buildView(ctx.db, ctx.projectId, feature.id);
  const idOf = (name: string) => {
    const found = view.snapshots.find((s) => s.name === name)?.id;
    if (!found) throw new Error(`no ${name} shot`);
    return found;
  };
  const decide = (name: string, state: "accepted" | "rejected") =>
    decideShot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: idOf(name),
      state,
      userId: ctx.userId,
    });
  const after = (name: string) =>
    afterDecision(ctx.db, {
      projectId: ctx.projectId,
      buildId: feature.id,
      snapshotId: idOf(name),
    });
  const between = (sql: string) => {
    pending = sql;
  };
  return { idOf, decide, after, between };
}

describe("what a decision answers", () => {
  test("after an accept it names the next shot still awaiting a decision, and the build's status", async () => {
    const { idOf, decide, after } = await changedBuild();
    await decide("about", "accepted");
    expect(await after("about")).toEqual({
      buildStatus: "changes",
      nextToReviewId: idOf("pricing"),
    });
  });

  test("it reads decisions made on the other shots since the page opened", async () => {
    const { decide, after } = await changedBuild();
    await decide("pricing", "accepted");
    await decide("about", "accepted");
    // Nothing is left to review, and the build has passed.
    expect(await after("about")).toEqual({ buildStatus: "passed", nextToReviewId: null });
  });

  test("another reviewer's reject shows as the build's status, before its build row is refreshed", async () => {
    const { idOf, decide, after, between } = await changedBuild();
    await decide("about", "accepted");
    // Another reviewer's reject lands its shot after the build row is read, before the shots are.
    between(`UPDATE snapshots SET review_state = 'rejected' WHERE id = '${idOf("pricing")}'`);
    expect((await after("about")).buildStatus).toBe("failed");
  });
});
