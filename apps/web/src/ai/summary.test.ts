import { describe, expect, test, vi } from "vitest";
import { getBuild } from "#/db/builds";
import type { Build } from "#/db/builds";
import { DIFF_BUDGET_MS } from "#/diff/budget";
import { processBuild } from "#/diff/process";
import { rerunShots } from "#/diff/rerun";
import { TEST_MODEL_KEY_SECRET as SECRET } from "#/db/test-db";
import {
  FINGERPRINT,
  type Ctx,
  consumerDeps,
  context,
  explaining,
  rows,
  sha,
  upload,
} from "#/diff/test-builds";
import type { BlobStore } from "#/storage/blobs";
import {
  KEY,
  NOTE,
  card,
  promptOf,
  red,
  stubModel,
  themedBuild,
  white,
  withModel,
} from "./summary-test-kit";
import { consumeExplain } from "./explain-queue";
import { memoryQueue } from "./explain-queue-kit";
import type { ModelFetch } from "./model";
import { summarizeBuild } from "./summary";

/**
 * A build's summary (ob 1668), against a stubbed OpenAI-compatible endpoint: nothing here reaches
 * a real one.
 */

const states = async (ctx: Ctx, build: Build) =>
  (await rows(ctx, build))
    .map((r) => `${r.name} ${r.diffStatus} ${r.reviewState}`)
    .toSorted((a, b) => a.localeCompare(b));

const idsOf = async (ctx: Ctx, build: Build, prefix: string) =>
  (await rows(ctx, build))
    .filter((r) => r.name.startsWith(prefix))
    .map((r) => r.id)
    .toSorted((a, b) => a.localeCompare(b));

describe("a build's AI summary (ob 1668)", () => {
  test("one text-only call per build, grouped across themes, each sentence linked to its shots", async () => {
    const ctx = await context();
    await withModel(ctx);
    const stub = stubModel(
      () =>
        "- The card's corner turned red in all 3 themes. [C1]\n**A fresh shot was added.** [N1]\n1. The gone shot was removed. [R1]",
    );
    const build = await themedBuild(ctx, stub.modelFetch);
    expect(stub.summaries()).toHaveLength(1);

    const body = stub.summaries()[0] ?? "";
    expect(body).not.toMatch(/image_url|data:image|base64/);
    const prompt = promptOf(body);
    expect(prompt).toContain("Build: 3 changed, 1 new, 1 removed.");
    // One item for the story, not three: the model is told it is the same story in 3 variants.
    expect(prompt.match(/^\[C\d+\]/gm)).toEqual(["[C1]"]);
    expect(prompt).toContain("[C1] Ui card hover: 3 of its 3 variants");
    expect(prompt).toContain("Catppuccin Mocha, 1280x720: 192 px changed; 1 region");
    expect(prompt).toContain(NOTE);
    expect(prompt).toMatch(/\[N1\] Fresh: 1 of its 1 variants/);
    expect(prompt).toMatch(/\[R1\] Gone: 1 of its 1 variants/);
    expect(prompt).not.toContain(KEY);

    const stored = (await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary;
    expect(stored).toMatchObject({ model: "local-qwen" });
    expect(stored?.at).toEqual(expect.any(Number));
    expect(stored?.sentences.map((s) => s.text)).toEqual([
      "The card's corner turned red in all 3 themes.",
      "A fresh shot was added.",
      "The gone shot was removed.",
    ]);
    expect(stored?.sentences[0]?.shots.toSorted((a, b) => a.localeCompare(b))).toEqual(
      await idsOf(ctx, build, "ui-card"),
    );
    expect(stored?.sentences[1]?.shots).toEqual(await idsOf(ctx, build, "fresh"));
    expect(stored?.sentences[2]?.shots).toEqual(await idsOf(ctx, build, "gone"));
  });

  test("the summary is written once, after the build's last shot is explained (ob 1875)", async () => {
    const ctx = await context();
    await withModel(ctx);
    const stub = stubModel();
    // Which kind of call came when: a region's crops, or the summary's text.
    const order: string[] = [];
    const modelFetch: ModelFetch = (input, init) => {
      order.push(
        typeof init.body === "string" && init.body.includes("image_url") ? "region" : "summary",
      );
      return stub.modelFetch(input, init);
    };
    await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
    const queue = memoryQueue();
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: card(red) },
      { modelFetch, queue },
    );
    expect(build.aiSummary).toBeNull();
    const jobs = queue.waiting.splice(0);
    expect(jobs.map((job) => job.body.kind)).toEqual(["shot", "shot", "shot"]);
    const deps = consumerDeps({ db: ctx.db, blobs: ctx.scoped, modelFetch });
    // Whether the build had a summary after each shot settled.
    const summarized: boolean[] = [];
    for (const job of jobs) {
      await consumeExplain(deps, [
        { body: job.body, attempts: 1, ack: () => undefined, retry: () => undefined },
      ]);
      summarized.push((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary !== null);
    }
    expect(summarized).toEqual([false, false, true]);
    // Three shots of one region each, then one summary that saw all three notes.
    expect(order).toEqual(["region", "region", "region", "summary"]);
    expect(promptOf(stub.summaries()[0] ?? "")).toContain(NOTE);
    // Delivered again, a settled shot asks nothing and writes no second summary.
    await consumeExplain(deps, [
      { body: jobs[0]?.body, attempts: 1, ack: () => undefined, retry: () => undefined },
    ]);
    expect(order).toHaveLength(4);
  });

  test("the summary changes no verdict and no review", async () => {
    const ctx = await context();
    await withModel(ctx);
    const asked = await themedBuild(ctx, stubModel().modelFetch);
    const other = await context();
    await withModel(other);
    const without = await themedBuild(
      other,
      stubModel(() => new Response("down", { status: 500 })).modelFetch,
    );
    expect(asked.aiSummary).not.toBeNull();
    expect(without.aiSummary).toBeNull();
    expect(asked.status).toBe(without.status);
    expect(await states(ctx, asked)).toEqual(await states(other, without));
  });

  test("an unmeasured shot is never described, and never as unchanged", async () => {
    const ctx = await context();
    await withModel(ctx);
    const stub = stubModel(
      () => "The card changed. [C1]\nThe settings shot is unchanged. [C1]\nAll else is fine.",
    );
    const regrown = {
      name: "settings",
      png: white,
      fingerprint: { ...FINGERPRINT, fonts: "sha256:other" },
    };
    const build = await themedBuild(ctx, stub.modelFetch, [regrown]);
    const settings = (await rows(ctx, build)).find((r) => r.name === "settings");
    expect(settings).toMatchObject({ diffStatus: null, rebaselineNeeded: true });

    const prompt = promptOf(stub.summaries()[0] ?? "");
    expect(prompt).not.toContain("Settings");
    const stored = (await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary;
    // The sentence calling a shot unchanged, and the one naming no shot, are dropped.
    expect(stored?.sentences.map((s) => s.text)).toEqual(["The card changed."]);
  });

  test("with no model configured nothing is sent and nothing is stored", async () => {
    const ctx = await context();
    const stub = stubModel();
    const build = await themedBuild(ctx, stub.modelFetch);
    expect(stub.summaries()).toHaveLength(0);
    expect(build.aiSummary).toBeNull();
  });

  test("a failed or malformed answer stores nothing: Regenerate keeps the summary, a re-run clears it", async () => {
    const ctx = await context();
    await withModel(ctx);
    const build = await themedBuild(ctx, stubModel(() => "First. [C1]").modelFetch);
    expect(build.aiSummary).not.toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const answers = [new Response("nope", { status: 401 }), "Everything looks good to me!"];
    for (const answer of answers) {
      const stub = stubModel(() => answer);
      const fresh = await getBuild(ctx.db, ctx.projectId, build.id);
      expect(
        await summarizeBuild(
          { db: ctx.db, modelFetch: stub.modelFetch, modelKeySecret: SECRET },
          fresh,
        ),
      ).toBe(false);
      expect(stub.summaries()).toHaveLength(1);
      // Nothing was measured again: what is stored still describes the build.
      expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary?.sentences[0]?.text).toBe(
        "First.",
      );
    }
    // A re-run measured the shot again: a summary of the old result would describe something else.
    const failing = stubModel(() => answers[1] ?? "");
    const [shotId] = await idsOf(ctx, build, "ui-card");
    await explaining(
      { db: ctx.db, blobs: ctx.scoped, modelFetch: failing.modelFetch },
      async (deps) =>
        rerunShots(deps, await getBuild(ctx.db, ctx.projectId, build.id), shotId ?? null),
    );
    expect(failing.summaries()).toHaveLength(1);
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [line] of warn.mock.calls) expect(String(line)).not.toContain(KEY);
    warn.mockRestore();
  });

  test("a default-branch build is accepted on finalise and not summarised", async () => {
    const ctx = await context();
    await withModel(ctx);
    const stub = stubModel(() => "New. [N1]");
    const build = await upload(
      ctx,
      { branch: "main", commit: sha(1), shots: card(white) },
      { modelFetch: stub.modelFetch },
    );
    expect(stub.summaries()).toHaveLength(0);
    expect(build.aiSummary).toBeNull();
    expect(
      await summarizeBuild(
        { db: ctx.db, modelFetch: stub.modelFetch, modelKeySecret: SECRET },
        build,
      ),
    ).toBe(false);
    expect(stub.summaries()).toHaveLength(0);
  });

  test("a build where nothing changed asks nothing", async () => {
    const ctx = await context();
    await withModel(ctx);
    await upload(
      ctx,
      { branch: "main", commit: sha(1), shots: card(white) },
      { modelFetch: stubModel(() => "New. [N1]").modelFetch },
    );
    const stub = stubModel();
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: card(white) },
      { modelFetch: stub.modelFetch },
    );
    expect(build.status).toBe("passed");
    expect(stub.summaries()).toHaveLength(0);
    expect(build.aiSummary).toBeNull();
  });

  test("Regenerate and a re-run each write it again", async () => {
    const ctx = await context();
    await withModel(ctx);
    const build = await themedBuild(ctx, stubModel(() => "First. [C1]").modelFetch);
    expect(build.aiSummary?.sentences[0]?.text).toBe("First.");

    const again = stubModel(() => "Second. [C1]");
    const stored = await getBuild(ctx.db, ctx.projectId, build.id);
    expect(
      await summarizeBuild(
        { db: ctx.db, modelFetch: again.modelFetch, modelKeySecret: SECRET },
        stored,
      ),
    ).toBe(true);
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary?.sentences[0]?.text).toBe(
      "Second.",
    );

    const rerun = stubModel(() => "Third. [C1]");
    const [shotId] = await idsOf(ctx, build, "ui-card");
    await explaining({ db: ctx.db, blobs: ctx.scoped, modelFetch: rerun.modelFetch }, (deps) =>
      rerunShots(deps, stored, shotId ?? null),
    );
    expect(rerun.summaries()).toHaveLength(1);
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).aiSummary?.sentences[0]?.text).toBe(
      "Third.",
    );
  });

  test("a resumed diff (ob 1645) has no summary while it is unfinished, and one when it finishes", async () => {
    const ctx = await context();
    await withModel(ctx);
    // A clock only a blob write advances: one 15 s shot per 25 s run, so three shots take three runs.
    let t = 0;
    const blobs: BlobStore = {
      ...ctx.scoped,
      put: async (key, body, type) => {
        t += 15_000;
        await ctx.scoped.put(key, body, type);
      },
    };
    const stub = stubModel();
    await upload(
      ctx,
      { branch: "main", commit: sha(1), shots: card(white) },
      { modelFetch: stub.modelFetch },
    );
    const before = stub.summaries().length;
    let build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: card(red) },
      { blobs, now: () => t, modelFetch: stub.modelFetch },
    );
    expect(build.status).toBe("errored");
    expect(build.aiSummary).toBeNull();
    for (let i = 0; i < 5 && build.status === "errored"; i++) {
      await explaining({ db: ctx.db, blobs, now: () => t, modelFetch: stub.modelFetch }, (deps) =>
        processBuild(deps, build),
      );
      build = await getBuild(ctx.db, ctx.projectId, build.id);
    }
    expect(build.status).toBe("changes");
    expect(t).toBeLessThan(10 * DIFF_BUDGET_MS);
    expect(stub.summaries().length - before).toBe(1);
    expect(build.aiSummary?.sentences[0]?.shots).toHaveLength(3);
  });
});
