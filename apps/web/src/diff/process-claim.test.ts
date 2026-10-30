import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { recordExplained } from "#/db/server-timings";
import { totalMs } from "#/lib/timings";
import type { BlobStore } from "#/storage/blobs";
import { claim, claimForRerun } from "./claim";
import { type Ctx, context, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A build that has `finished_at` has ended (PS-193). The LAN server showed three builds `processing`
 * with `finished_at` a hundred milliseconds before `processing_started_at`: the first run hit the
 * budget and ended the build `errored` with its timings, the CLI sent finalise again at once, the
 * claim moved the build back to `processing` and left the first run's `finished_at`, and the
 * Worker was then killed (OOM) before the second run ended. Nothing after the claim wrote the end.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const names = (n: number) => Array.from({ length: n }, (_, i) => `shot-${i}`);

/** A clock only a blob write advances, by `cost` ms: the 25 s budget stops a run after two 10 s shots. */
function timed(ctx: Ctx, cost: number) {
  let t = 0;
  const blobs: BlobStore = {
    ...ctx.scoped,
    put: async (key, body, type) => {
      t += cost;
      await ctx.scoped.put(key, body, type);
    },
  };
  return { blobs, now: () => t };
}

async function erroredByBudget(ctx: Ctx) {
  const list = names(5);
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: list.map((name) => ({ name, png: white })),
  });
  const clock = timed(ctx, 10_000);
  const first = await upload(
    ctx,
    {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: list.map((name) => ({ name, png: red })),
    },
    { blobs: clock.blobs, now: clock.now },
  );
  expect(first.status).toBe("errored");
  const errored = await getBuild(ctx.db, ctx.projectId, first.id);
  expect(errored.finishedAt).not.toBeNull();
  return errored;
}

describe("a claim takes the end of the earlier run off the build", () => {
  test("a resume claimed from errored, whose run is then killed, has no finished_at", async () => {
    const ctx = await context();
    const errored = await erroredByBudget(ctx);

    // The second run claims the build and the process dies: nothing else runs.
    expect(await claim(ctx.db, errored, { ci: false, startedAt: new Date() })).toBe(true);

    const stuck = await getBuild(ctx.db, ctx.projectId, errored.id);
    expect(stuck.status).toBe("processing");
    expect(stuck.finishedAt).toBeNull();
    expect(stuck.queueMs).toBeNull();
    expect(stuck.diffMs).toBeNull();
    expect(totalMs(stuck)).toBeNull();
  });

  test("a reviewer's re-run claimed from a verdict, then killed, has no finished_at", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const done = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: red }],
    });
    const verdict = await getBuild(ctx.db, ctx.projectId, done.id);
    expect(verdict.status).toBe("changes");
    expect(verdict.finishedAt).not.toBeNull();

    expect(await claimForRerun(ctx.db, verdict, new Date())).toBe(true);

    const stuck = await getBuild(ctx.db, ctx.projectId, done.id);
    expect(stuck).toMatchObject({ status: "processing", finishedAt: null });
  });

  test("a late explanation of the run before does not stamp a build a rerun holds", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const done = await upload(ctx, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: red }],
    });
    const verdict = await getBuild(ctx.db, ctx.projectId, done.id);
    expect(await claimForRerun(ctx.db, verdict, new Date())).toBe(true);

    // Another shot's explanation, queued before the claim, settles after it.
    await recordExplained(ctx.db, done.id, { queuedAt: 0, now: 5 });

    const held = await getBuild(ctx.db, ctx.projectId, done.id);
    expect(held).toMatchObject({ status: "processing", finishedAt: null });
  });
});
