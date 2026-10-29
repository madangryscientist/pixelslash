import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { Db } from "#/db/db";
import { builds, snapshots } from "#/db/schema";
import { type Ctx, FINGERPRINT, context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A build never claims a verdict on shots it did not measure (PS-282, invariant 1). On the LAN a
 * branch build whose every shot came from another environment ended `passed` ("No visual
 * changes", 1,223 not measured), and the next build took it as its baseline and dropped the
 * branch's open changes.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const NEW_FONTS = { ...FINGERPRINT, fonts: "sha256:g" };

const onBranch = (commit: number, fingerprint = FINGERPRINT) => ({
  branch: "feat/x",
  commit: sha(commit),
  mergeBase: sha(1),
  shots: [{ png: red, fingerprint }],
});

/** Main, then a branch build with a change nobody has decided. */
async function openChange() {
  const ctx = await context();
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  const first = await upload(ctx, onBranch(2));
  expect(first.status).toBe("changes");
  return { ctx, first, firstShot: await onlyShot(ctx, first) };
}

/** A `Db` in front of the store whose writes of a shot's result are lost, as a run that raced another's. */
function losesResults(db: Db): Db {
  const update: Db["update"] = (table) => {
    const builder = db.update(table);
    if (!Object.is(table, snapshots)) return builder;
    const set = builder.set.bind(builder);
    return new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop !== "set") return Reflect.get(target, prop, receiver);
        return (values: Parameters<typeof set>[0]) =>
          set("diffStatus" in values ? { ...values, diffStatus: null } : values);
      },
    });
  };
  return new Proxy(db, {
    get: (target, prop, receiver) =>
      prop === "update" ? update : Reflect.get(target, prop, receiver),
  });
}

/** The state 6940ccb7 was left in before PS-282: every shot null, the build passed. */
async function leftUnmeasured(ctx: Ctx, buildId: string) {
  await ctx.db
    .update(snapshots)
    .set({ diffStatus: null, diffResult: null, rebaselineNeeded: true, carriedFrom: null })
    .where(eq(snapshots.buildId, buildId));
  await ctx.db.update(builds).set({ status: "passed" }).where(eq(builds.id, buildId));
}

describe("a build with shots it did not measure", () => {
  test("a branch build captured in another environment errors naming it, it does not pass", async () => {
    const { ctx } = await openChange();
    const moved = await upload(ctx, onBranch(3, NEW_FONTS));
    expect(await onlyShot(ctx, moved)).toMatchObject({ diffStatus: null, rebaselineNeeded: true });
    expect(moved.status).toBe("errored");
    expect(moved.error).toContain("1 of 1 shots");
    expect(moved.error).toContain("fonts sha256:f → sha256:g");
  });

  test("a shot whose result never landed errors the build, it does not pass", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const lost = await upload(ctx, onBranch(2), { db: losesResults(ctx.db) });
    expect(lost.status).toBe("errored");
    expect(lost.error).toContain("1 of 1 shots have no result");
  });

  test("a passed build left unmeasured is not the next build's baseline: the open change is carried", async () => {
    const { ctx, firstShot } = await openChange();
    const carrier = await upload(ctx, onBranch(3));
    await leftUnmeasured(ctx, carrier.id);
    const next = await upload(ctx, onBranch(4));
    expect(await onlyShot(ctx, next)).toMatchObject({
      diffStatus: "unchanged",
      baselineKey: firstShot.imageKey,
      carriedFrom: firstShot.id,
    });
    expect(next.status).toBe("changes");
  });

  test("the default branch moves to a new environment: accepted, and the next build's baseline", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const moved = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      ancestors: [sha(1)],
      shots: [{ png: white, fingerprint: NEW_FONTS }],
    });
    expect(moved.status).toBe("passed");
    const movedShot = await onlyShot(ctx, moved);
    expect(movedShot).toMatchObject({ rebaselineNeeded: true, reviewState: "accepted" });
    const branch = await upload(ctx, { ...onBranch(3, NEW_FONTS), mergeBase: sha(2) });
    expect(await onlyShot(ctx, branch)).toMatchObject({
      diffStatus: "changed",
      baselineKey: movedShot.imageKey,
    });
  });

  test("once main is captured in the new environment, the branch's next build is measured against it", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const before = await upload(ctx, { ...onBranch(2), shots: [{ png: white }] });
    expect(before.status).toBe("passed");
    const recaptured = await upload(ctx, {
      branch: "main",
      commit: sha(5),
      ancestors: [sha(1)],
      shots: [{ png: white, fingerprint: NEW_FONTS }],
    });
    const mainShot = await onlyShot(ctx, recaptured);
    const after = await upload(ctx, { ...onBranch(3, NEW_FONTS), mergeBase: sha(5) });
    expect(await onlyShot(ctx, after)).toMatchObject({
      diffStatus: "changed",
      baselineKey: mainShot.imageKey,
    });
    expect(after.status).toBe("changes");
  });
});
