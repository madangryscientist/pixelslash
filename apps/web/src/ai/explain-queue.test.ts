import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getBuild } from "#/db/builds";
import { snapshots } from "#/db/schema";
import { DIFF_BUDGET_MS } from "#/diff/budget";
import { consumerDeps, context, onlyShot, sha, upload } from "#/diff/test-builds";
import { EXPLAIN_ATTEMPTS, consumeExplain } from "./explain-queue";
import { memoryQueue } from "./explain-queue-kit";
import { RED, shot } from "#/diff/test-shots";
import { KEY, branchBuild, stubModel, twoChanges, white, withModel } from "./explain-test-kit";
import { MODEL_TIMEOUT_MS, type ModelFetch } from "./model";

/**
 * Explaining off the finalise request (ob 1875): each shot is a job on the explain queue, and each
 * model call has the whole MODEL_TIMEOUT_MS, whatever the diff spent. Against a stubbed endpoint.
 */

/** The database answers in real time: the faked clock moves a second at a time between its replies. */
async function tick(): Promise<false> {
  await vi.advanceTimersByTimeAsync(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  return false;
}

describe("the explain queue (ob 1875)", () => {
  test("a diff that used the run's budget still leaves the model its own time (ob 1875)", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    // Each reading of the clock is a quarter of the budget: the diff alone spends all of it.
    let t = 0;
    const now = () => (t += DIFF_BUDGET_MS / 4);
    const queue = memoryQueue();
    const { sent, modelFetch } = stubModel();
    // A model that takes 15 s, as one call to a reasoning model on the LAN does, unless it is stopped.
    const slow: ModelFetch = (url, init) =>
      new Promise((resolve, reject) => {
        const answer = setTimeout(() => resolve(modelFetch(url, init)), 15_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(answer);
          reject(init.signal?.reason);
        });
      });
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
      { modelFetch: slow, now, queue },
    );
    expect(build).toMatchObject({ status: "changes", error: null });
    expect((await onlyShot(ctx, build)).aiQueuedAt).not.toBeNull();
    // The calls' timeouts on the test's clock, so 15 s pass without waiting for them.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      asked.push(ms);
      const stop = new AbortController();
      setTimeout(() => stop.abort(new DOMException("timed out", "TimeoutError")), ms);
      return stop.signal;
    });
    try {
      const drained = queue.drain(
        consumerDeps({ db: ctx.db, blobs: ctx.scoped, now, modelFetch: slow }),
      );
      const settled = drained.then(() => true);
      for (let done = false; !done;) done = await Promise.race([settled, tick()]);
      await drained;
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
    // Two regions and the summary, each with the whole MODEL_TIMEOUT_MS.
    expect(asked).toEqual([MODEL_TIMEOUT_MS, MODEL_TIMEOUT_MS, MODEL_TIMEOUT_MS]);
    expect(sent).toHaveLength(2);
    const row = await onlyShot(ctx, build);
    expect(row.aiReview?.regions).toHaveLength(2);
    expect(row).toMatchObject({ aiQueuedAt: null, aiError: null });
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary).not.toBeNull();
  });

  test("a model that keeps failing ends the shot with the named failure, and the build keeps its verdict", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { sent, modelFetch } = stubModel(() => new Response("nope", { status: 401 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const build = await branchBuild(ctx, modelFetch);
    // Both regions, on each of the shot's tries (ob 1875).
    expect(sent).toHaveLength(2 * EXPLAIN_ATTEMPTS);
    // One line per shot given up says why, so a wrong key can be found; it never carries the key.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("the model answered 401");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEY);
    warn.mockRestore();
    const row = await onlyShot(ctx, build);
    expect(row.aiReview).toBeNull();
    // Not left explaining: the page names why the model has nothing for it.
    expect(row).toMatchObject({ aiQueuedAt: null, aiError: "the model answered 401" });
    expect(row.reviewState).toBe("pending");
    expect(build).toMatchObject({ status: "changes", error: null });
  });

  test("a shot's region calls are at most six at once, the connections one invocation has", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    // Eight regions far enough apart not to merge: a 4 by 2 grid of red squares.
    const size = { width: 800, height: 400 };
    const eight = shot({
      ...size,
      blocks: Array.from({ length: 8 }, (_, i) => ({
        x: 40 + (i % 4) * 200,
        y: 40 + Math.floor(i / 4) * 200,
        w: 10,
        h: 10,
        rgb: RED,
      })),
    });
    const { sent, modelFetch } = stubModel();
    let open = 0;
    let most = 0;
    const counted: ModelFetch = async (url, init) => {
      open += 1;
      most = Math.max(most, open);
      // Long enough that every call the shot would start at once has started.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      open -= 1;
      return modelFetch(url, init);
    };
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: shot(size) }] });
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: eight }] },
      { modelFetch: counted },
    );
    expect(sent).toHaveLength(8);
    expect(most).toBe(6);
    expect((await onlyShot(ctx, build)).aiReview?.regions).toHaveLength(8);
  });

  test("a shot changed only in size has no region to ask about, so it is not queued", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    const { sent, modelFetch } = stubModel();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ png: shot({ width: 200, height: 100 }) }],
    });
    const queue = memoryQueue();
    const build = await upload(
      ctx,
      {
        branch: "feat/x",
        commit: sha(2),
        mergeBase: sha(1),
        shots: [{ png: shot({ width: 200, height: 140 }) }],
      },
      { modelFetch, queue },
    );
    const row = await onlyShot(ctx, build);
    expect(row.diffStatus).toBe("changed");
    expect(row).toMatchObject({ aiQueuedAt: null, aiError: null, aiReview: null });
    expect(queue.waiting.map((job) => job.body.kind)).toEqual(["summary"]);
    expect(sent).toHaveLength(0);
  });

  test("a job from before a re-run queued the shot again owns nothing, even on its last try", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const queue = memoryQueue();
    const { sent, modelFetch } = stubModel();
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
      { modelFetch, queue },
    );
    const [old] = queue.waiting.splice(0);
    const row = await onlyShot(ctx, build);
    // The re-run's own queueing, a moment later.
    const again = new Date((row.aiQueuedAt?.getTime() ?? 0) + 1);
    await ctx.db.update(snapshots).set({ aiQueuedAt: again }).where(eq(snapshots.id, row.id));
    await consumeExplain(consumerDeps({ db: ctx.db, blobs: ctx.scoped, modelFetch }), [
      { body: old?.body, attempts: EXPLAIN_ATTEMPTS, ack: () => undefined, retry: () => undefined },
    ]);
    expect(sent).toHaveLength(0);
    expect(await onlyShot(ctx, build)).toMatchObject({ aiQueuedAt: again, aiError: null });
  });
});
