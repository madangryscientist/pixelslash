import { describe, expect, test, vi } from "vitest";
import { getBuild } from "#/db/builds";
import { rerunShots } from "#/diff/rerun";
import { consumerDeps, context, explaining, rows, sha, upload } from "#/diff/test-builds";
import { memoryQueue } from "./explain-queue-kit";
import type { ModelFetch } from "./model";
import { card, red, stubModel, white, withModel } from "./summary-test-kit";

/** A summary written off the queue (ob 1875) and a re-run that queues the build again meanwhile. */

describe("the queued summary and a re-run (ob 1875)", () => {
  test("a summary still being asked when a re-run queues the build again is not stored over it (ob 1875)", async () => {
    const ctx = await context();
    await withModel(ctx);
    const old = stubModel(() => "Old. [C1]");
    // The old summary's answer waits until the re-run has written its own.
    const { promise: held, resolve: answer } = Promise.withResolvers<void>();
    let asking = false;
    const asked: ModelFetch = async (input, init) => {
      const summary = typeof init.body === "string" && !init.body.includes("image_url");
      if (summary) {
        asking = true;
        await held;
      }
      return old.modelFetch(input, init);
    };
    await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
    const queue = memoryQueue();
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: card(red) },
      { modelFetch: asked, queue },
    );
    const draining = queue.drain(
      consumerDeps({ db: ctx.db, blobs: ctx.scoped, modelFetch: asked }),
    );
    await vi.waitFor(() => expect(asking).toBe(true));
    // Still pending while it is asked, so the page keeps waiting for it.
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummaryQueuedAt).not.toBeNull();
    const fresh = stubModel(() => "New. [C1]");
    const [shot] = await rows(ctx, build);
    const stored = await getBuild(ctx.db, ctx.projectId, build.id);
    await explaining({ db: ctx.db, blobs: ctx.scoped, modelFetch: fresh.modelFetch }, (deps) =>
      rerunShots(deps, stored, shot?.id ?? null),
    );
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary?.sentences[0]?.text).toBe(
      "New.",
    );
    answer();
    await draining;
    expect(old.summaries()).toHaveLength(1);
    const after = await getBuild(ctx.db, ctx.projectId, build.id);
    expect(after.aiSummary?.sentences[0]?.text).toBe("New.");
    expect(after).toMatchObject({ aiSummaryQueuedAt: null, aiSummaryClaimedAt: null });
  });
});
