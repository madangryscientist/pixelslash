import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import type { Db } from "#/db/db";
import { refreshBuildStatus, reviewSnapshot } from "#/db/review";
import { context, FINGERPRINT, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * The server's half of the diff (ob 1470): which shot is the baseline, and what the build does
 * with the verdict. The measurement itself is the engine's and is tested there.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

const VERDICTS: ReadonlySet<unknown> = new Set(["changes", "passed", "failed"]);
/** The statuses the diff writes: a verdict, or the reason it could not reach one. */
const RECORDED: ReadonlySet<unknown> = new Set([...VERDICTS, "errored"]);

/**
 * A `Db` in front of the test store that records the statuses the diff writes and, when asked,
 * fails the verdict one the way a contending D1 write does. The claim (`processing`) and the
 * `errored` write carrying a reason are let through: the store is otherwise healthy and only the
 * verdict statement throws.
 */
function statusWrites(db: Db, failVerdict = false) {
  const writes: unknown[] = [];
  const update: Db["update"] = (...args) => {
    const builder = db.update(...args);
    const set = builder.set.bind(builder);
    return new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop !== "set") return Reflect.get(target, prop, receiver);
        return (values: Parameters<typeof set>[0]) => {
          const status = "status" in values ? values.status : null;
          if (failVerdict && status !== null && VERDICTS.has(status)) throw new Error("d1 blip");
          if (status !== null && RECORDED.has(status)) writes.push(values);
          return set(values);
        };
      },
    });
  };
  return {
    db: new Proxy(db, {
      get(target, prop, receiver) {
        return prop === "update" ? update : Reflect.get(target, prop, receiver);
      },
    }),
    writes,
  };
}

describe("baseline selection", () => {
  test("the main build at the merge-base is the baseline; an identical shot is unchanged", async () => {
    const ctx = await context();
    const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const mainShot = await onlyShot(ctx, main);
    expect(main.status).toBe("passed");
    expect(mainShot?.reviewState).toBe("accepted");

    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: white }],
    });
    const branchShot = await onlyShot(ctx, branch);
    expect(branch.status).toBe("passed");
    expect(branchShot).toMatchObject({
      diffStatus: "unchanged",
      baselineKey: mainShot?.imageKey,
      rebaselineNeeded: false,
    });
    expect(branchShot?.diffKey).toMatch(/\.diff\.png$/);
  });

  test("an acceptance on the branch carries forward after a rebase", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const first = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: red }],
    });
    expect(first.status).toBe("changes");
    const firstShot = await onlyShot(ctx, first);
    expect(
      await reviewSnapshot(ctx.db, {
        projectId: ctx.projectId,
        snapshotId: firstShot?.id ?? "",
        state: "accepted",
        userId: ctx.userId,
      }),
    ).toBe("passed");

    // Rebased: commit sha(2) is not an ancestor any more, and no main build holds this shot.
    const second = await upload(ctx, {
      branch: "feat/x",
      commit: sha(3),
      mergeBase: sha(9),
      ancestors: [sha(3)],
      shots: [{ png: red }],
    });
    const secondShot = await onlyShot(ctx, second);
    expect(secondShot).toMatchObject({
      diffStatus: "unchanged",
      baselineKey: firstShot?.imageKey,
    });
    expect(second.status).toBe("passed");
  });

  test("a squash-merged main build is auto-accepted and is the next baseline", async () => {
    const ctx = await context();
    const before = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const squash = await upload(ctx, {
      branch: "main",
      commit: sha(2),
      ancestors: [sha(1)],
      shots: [{ png: white }],
    });
    const squashShot = await onlyShot(ctx, squash);
    expect(squash.status).toBe("passed");
    expect(squashShot?.reviewState).toBe("accepted");
    expect([...(await rows(ctx, before))].map((r) => r.id)).not.toContain(squashShot?.id);

    const branch = await upload(ctx, {
      branch: "feat/y",
      commit: sha(3),
      mergeBase: sha(2),
      shots: [{ png: red }],
    });
    const branchShot = await onlyShot(ctx, branch);
    expect(branchShot).toMatchObject({ diffStatus: "changed", baselineKey: squashShot?.imageKey });
    expect(branch.status).toBe("changes");
  });

  test("a fingerprint change needs a re-baseline: not compared, and it does not block", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: red, fingerprint: { ...FINGERPRINT, browser: "chromium 149" } }],
    });
    const branchShot = await onlyShot(ctx, branch);
    expect(branchShot).toMatchObject({
      diffStatus: null,
      diffResult: null,
      rebaselineNeeded: true,
    });
    expect(branchShot?.diffKey).toBeNull();
    expect(branch.status).toBe("passed");
  });
});

describe("build status", () => {
  test("a changed shot blocks until it is accepted", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: red }],
    });
    expect(branch.status).toBe("changes");
    const branchShot = await onlyShot(ctx, branch);
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: branchShot?.id ?? "",
      state: "accepted",
      userId: ctx.userId,
    });
    expect((await getBuild(ctx.db, ctx.projectId, branch.id)).status).toBe("passed");
    expect(branchShot?.diffStatus).toBe("changed");
  });

  test("the happy path writes the verdict once and blocks on it", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const store = statusWrites(ctx.db);
    const branch = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
      { db: store.db },
    );
    expect(branch.status).toBe("changes");
    expect(store.writes).toEqual([{ status: "changes" }]);
  });

  test("a status write that throws ends the build at errored, never processing", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const store = statusWrites(ctx.db, true);
    const branch = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: white }] },
      { db: store.db },
    );
    expect(branch.status).toBe("errored");
    expect(branch.error).toBe("d1 blip");
    // The verdict write failed; the reason was written instead, so nothing is left measuring.
    expect(store.writes).toEqual([{ status: "errored", error: "d1 blip" }]);
  });

  test("new and removed shots do not block", async () => {
    const ctx = await context();
    const main = await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ png: white }, { name: "checkout", png: white }],
    });
    const [, gone] = await rows(ctx, main);
    expect(gone?.name).toBe("checkout");

    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: white }, { name: "signup", png: white }],
    });
    const held = await rows(ctx, branch);
    expect(held.find((r) => r.name === "signup")?.diffStatus).toBe("new");
    expect(held.find((r) => r.name === "checkout")).toMatchObject({
      diffStatus: "removed",
      imageKey: gone?.imageKey,
    });
    expect(branch.status).toBe("passed");
  });

  test("any rejection fails the build; the next build is judged on its own", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const first = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: red }],
    });
    const firstShot = await onlyShot(ctx, first);
    const verdict = await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: firstShot?.id ?? "",
      state: "rejected",
      userId: ctx.userId,
    });
    expect(verdict).toBe("failed");
    expect((await getBuild(ctx.db, ctx.projectId, first.id)).status).toBe("failed");

    const second = await upload(ctx, {
      branch: "feat/x",
      commit: sha(3),
      mergeBase: sha(1),
      ancestors: [sha(2)],
      shots: [{ png: red }],
    });
    expect(second.status).toBe("changes");
    expect(await refreshBuildStatus(ctx.db, first.id)).toBe("failed");
  });

  test("the engine's verdict is the only one that blocks", async () => {
    const ctx = await context();
    const flat = shot({ base: [200, 200, 200] });
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: flat }] });
    // A speckled patch is noise: differing pixels, but no `change` region survives.
    const noisy = shot({
      base: [200, 200, 200],
      noise: { x: 10, y: 10, w: 12, h: 12, rgb: [0, 0, 0] },
    });
    const branch = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: noisy }],
    });
    const branchShot = await onlyShot(ctx, branch);
    expect(branchShot?.diffStatus).toBe("unchanged");
    expect(branchShot?.diffResult?.regions.every((r) => r.kind !== "change")).toBe(true);
    expect(branch.status).toBe("passed");
  });
});

/** A clock that advances `step` ms per reading, so each shot appears to cost a fixed time. */
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};

async function build(ctx: Awaited<ReturnType<typeof context>>, now: () => number) {
  const named = (png: typeof white) => ["a", "b", "c"].map((name) => ({ name, png }));
  await upload(ctx, { branch: "main", commit: sha(1), shots: named(white) });
  return upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: named(red) },
    { now },
  );
}

describe("the Worker ceiling", () => {
  test("a build whose shots cannot all finish ends errored, naming the limit", async () => {
    const ctx = await context();
    // Each shot reads ~3 ticks of 4 s: the third would pass the 25 s budget.
    const branch = await build(ctx, clock(4000));
    expect(branch.status).toBe("errored");
    expect(branch.error).toMatch(/diff ceiling: measured \d of 3 shots/);
    expect(branch.error).toContain("30 s CPU limit");
    expect(branch.error).toContain("one whole-page change at 1280x4000");
  });

  test("a build inside the budget is not stopped", async () => {
    const ctx = await context();
    const branch = await build(ctx, clock(10));
    expect(branch.status).toBe("changes");
    expect(branch.error).toBeNull();
  });

  test("a throw while the diff runs is recorded as errored, with its message", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const branch = await upload(
      ctx,
      {
        branch: "feat/x",
        commit: sha(2),
        mergeBase: sha(1),
        shots: [{ png: red }],
      },
      {
        now: () => {
          throw new Error("isolate died");
        },
      },
    );
    expect(branch.status).toBe("errored");
    expect(branch.error).toBe("isolate died");
  });
});
