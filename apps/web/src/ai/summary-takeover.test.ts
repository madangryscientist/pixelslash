import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { builds } from "#/db/schema";
import { type Ctx, consumerDeps, context, sha, upload } from "#/diff/test-builds";
import { EXPLAIN_STALE_MS } from "./explain-pending";
import { memoryQueue } from "./explain-queue-kit";
import { card, red, stubModel, white, withModel } from "./summary-test-kit";

/** A summary claimed by a consumer that died is taken over by a later call once the claim is stale (PS-396). */

/**
 * A build whose summary is queued and claimed `age` ms before the consumer's clock, then the queue
 * drained: the last shot job to settle calls `summarizeWhenExplained`.
 */
async function claimedThenDrained(ctx: Ctx, age: number) {
  await withModel(ctx);
  const model = stubModel(() => "Taken. [C1]");
  await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
  const queue = memoryQueue();
  const build = await upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: card(red) },
    { modelFetch: model.modelFetch, queue },
  );
  const now = Date.now();
  const claimedAt = new Date(now - age);
  await ctx.db.update(builds).set({ aiSummaryClaimedAt: claimedAt }).where(eq(builds.id, build.id));
  await queue.drain(
    consumerDeps({
      db: ctx.db,
      blobs: ctx.scoped,
      modelFetch: model.modelFetch,
      now: () => now,
    }),
  );
  return { model, claimedAt, after: await getBuild(ctx.db, ctx.projectId, build.id) };
}

describe("a stale summary claim (PS-396)", () => {
  test("a claim older than EXPLAIN_STALE_MS is taken over and the summary is written", async () => {
    const ctx = await context();
    const { model, after } = await claimedThenDrained(ctx, EXPLAIN_STALE_MS + 1);
    expect(model.summaries()).toHaveLength(1);
    expect(after.aiSummary?.sentences[0]?.text).toBe("Taken.");
    expect(after).toMatchObject({ aiSummaryQueuedAt: null, aiSummaryClaimedAt: null });
  });

  test("a claim a minute younger than the limit is left to its claimer", async () => {
    const ctx = await context();
    const { model, claimedAt, after } = await claimedThenDrained(ctx, EXPLAIN_STALE_MS - 60_000);
    expect(model.summaries()).toHaveLength(0);
    expect(after.aiSummary).toBeNull();
    expect(after.aiSummaryQueuedAt).not.toBeNull();
    expect(after.aiSummaryClaimedAt).toEqual(claimedAt);
  });
});
