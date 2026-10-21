import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { snapshots } from "#/db/schema";
import type { BlobStore } from "#/storage/blobs";
import { processBuild } from "./process";
import { type Ctx, context, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** A build bigger than one run's budget is resumed, not restarted (ob 1645). */

/** What a build's shots hold, by name: the part of a result a run must not change. */
const view = (r: Awaited<ReturnType<typeof rows>>) =>
  r
    .map((x) => [x.name, x.diffStatus, x.diffResult?.changedPixels, x.reviewState])
    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const names = (n: number) => Array.from({ length: n }, (_, i) => `shot-${i}`);
const named = (list: string[], png: typeof white) => list.map((name) => ({ name, png }));

/**
 * A fake clock that only a diff's blob write advances, by `cost` ms: with the 25 s budget and a
 * 10 s shot, two shots fit in a run (the third would pass it). `puts` is every key written.
 */
function timed(ctx: Ctx, cost: number) {
  let t = 0;
  const puts: string[] = [];
  const blobs: BlobStore = {
    ...ctx.scoped,
    put: async (key, body, type) => {
      t += cost;
      puts.push(key);
      await ctx.scoped.put(key, body, type);
    },
  };
  return { blobs, now: () => t, puts };
}

/** Run the diff again until the build leaves `errored`; the result of every run. */
async function runsToFinish(ctx: Ctx, id: string, clock: ReturnType<typeof timed>) {
  const results = [];
  for (let i = 0; i < 20; i++) {
    const build = await getBuild(ctx.db, ctx.projectId, id);
    if (build.status !== "errored") break;
    results.push(await processBuild({ db: ctx.db, blobs: clock.blobs, now: clock.now }, build));
  }
  return results;
}

async function mainThen(ctx: Ctx, list: string[]) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: named(list, white) });
}

describe("a re-run resumes", () => {
  test("N shots with k per run finish in ceil(N/k) runs, no shot diffed twice, same verdict as one run", async () => {
    const list = names(5);
    const ctx = await context();
    await mainThen(ctx, list);
    const clock = timed(ctx, 10_000);
    const first = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: named(list, red) },
      { blobs: clock.blobs, now: clock.now },
    );
    // Run 1 of ceil(5/2) = 3: it stops with the rest unmeasured and says so; no verdict yet.
    expect(first.status).toBe("errored");
    expect(first.error).toMatch(/measured 2 of 5 shots \(3 left\)/);
    const measured = (await rows(ctx, first)).filter((r) => r.diffStatus !== null);
    expect(measured).toHaveLength(2);

    const later = await runsToFinish(ctx, first.id, clock);
    expect(later.map((r) => [r.status, r.unmeasured])).toEqual([
      ["errored", 1],
      ["changes", 0],
    ]);
    expect(clock.puts).toHaveLength(5);
    expect(new Set(clock.puts).size).toBe(5);

    // The same build in one unbounded run gives the same verdict and the same per-shot results.
    const alone = await context();
    await mainThen(alone, list);
    const whole = await upload(alone, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: named(list, red),
    });
    const resumed = await getBuild(ctx.db, ctx.projectId, first.id);
    expect(resumed.status).toBe(whole.status);
    expect(view(await rows(ctx, first))).toEqual(view(await rows(alone, whole)));
  });

  test("a build with unmeasured shots is never passed, whatever their number", async () => {
    const list = names(4);
    const ctx = await context();
    await mainThen(ctx, list);
    const clock = timed(ctx, 30_000);
    const first = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: named(list, white) },
      { blobs: clock.blobs, now: clock.now },
    );
    // Identical shots are unchanged: the verdict would be `passed`, but 3 are not measured. The
    // clock only moves on a write, and an unchanged shot also writes its overlay, so one fits.
    expect(first.status).toBe("errored");
    expect((await rows(ctx, first)).filter((r) => r.diffStatus === null)).toHaveLength(3);
  });

  test("a shot whose baseline changed between runs is measured again, not left stale", async () => {
    const list = names(3);
    const ctx = await context();
    await mainThen(ctx, list);
    // An earlier build on the branch, not yet accepted: not a baseline (main's is).
    const earlier = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: named(list, red),
    });
    const clock = timed(ctx, 10_000);
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(3), mergeBase: sha(1), shots: named(list, red) },
      { blobs: clock.blobs, now: clock.now },
    );
    expect(build.status).toBe("errored");
    const done = (await rows(ctx, build)).find((r) => r.diffStatus !== null);
    expect(done).toMatchObject({ diffStatus: "changed" });

    // Between the runs, the earlier build's shot of the same name is accepted: it is now the
    // baseline (same branch, newer), and the red shot is unchanged against it.
    const theirs = (await rows(ctx, earlier)).find((r) => r.name === done?.name);
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: theirs?.id ?? "",
      state: "accepted",
      userId: ctx.userId,
    });
    const runs = await runsToFinish(ctx, build.id, clock);
    // The count a client reads includes the shot sent back for a new baseline, so it keeps falling.
    const left = runs.map((r) => r.unmeasured);
    expect(left.at(-1)).toBe(0);
    expect(left.slice(0, -1).every((n) => n > 0)).toBe(true);
    expect(left).toEqual(left.toSorted((a, b) => b - a));

    const after = await ctx.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, done?.id ?? ""));
    expect(after[0]).toMatchObject({ diffStatus: "unchanged", baselineKey: theirs?.imageKey });
    const final = await getBuild(ctx.db, ctx.projectId, build.id);
    expect(final.status).toBe("changes");
  });
});
