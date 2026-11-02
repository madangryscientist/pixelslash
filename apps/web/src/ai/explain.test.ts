import { cropBox } from "@hackcove/pixelslash-engine/region-crops";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { snapshots } from "#/db/schema";
import { rerunShots } from "#/diff/rerun";
import { context, onlyShot, sha, upload, explaining } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import {
  BASE_URL,
  BOTTOM_RIGHT,
  branchBuild,
  H,
  KEY,
  pixel,
  stubModel,
  TOP_LEFT,
  W,
  white,
  withModel,
} from "./explain-test-kit";
import type { ModelFetch } from "./model";

/**
 * Explaining changed regions with the project's own model (ob 1473), against a stubbed
 * OpenAI-compatible endpoint: nothing here reaches a real one.
 */

describe("explaining changed regions (ob 1473)", () => {
  test("one call per change region, each with that region's three crops only", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    const { sent, sessions, modelFetch } = stubModel((n) =>
      n === 0 ? "LABEL intended\nWHY A red block was added." : "LABEL unintended\nWHY Overlap.",
    );
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
    // Both region calls and the summary call name the build as their session.
    expect(sessions).toEqual([build.id, build.id, build.id]);
    const regions = (row.diffResult?.regions ?? []).filter((r) => r.kind === "change");
    expect(regions).toHaveLength(2);
    expect(sent).toHaveLength(2);

    for (const call of sent) {
      expect(call.url).toBe(`${BASE_URL}/chat/completions`);
      expect(call.auth).toBe(`Bearer ${KEY}`);
      expect(call.model).toBe("deepseek-flash");
      expect(call.images).toHaveLength(3);
    }
    // Each call's crops are its region plus the padding, cut from the same place in all three.
    const asked = regions.map((region) => {
      const box = cropBox(region, W, H);
      if (!box) throw new Error("region outside the shot");
      const call = sent.find((c) => c.images[0]?.width === box.w && c.images[0].height === box.h);
      if (!call) throw new Error(`no call sent a ${box.w}x${box.h} crop`);
      const [main, branch, diff] = call.images;
      for (const img of [main, branch, diff])
        expect([img?.width, img?.height]).toEqual([box.w, box.h]);
      const inside = { x: region.x - box.x + 1, y: region.y - box.y + 1 };
      if (!main || !branch) throw new Error("missing crop");
      expect(pixel(main, inside.x, inside.y)).toEqual([255, 255, 255]);
      expect(pixel(branch, inside.x, inside.y)).toEqual(RED);
      return call;
    });
    expect(new Set(asked).size).toBe(2);

    expect(row.aiReview).toMatchObject({ model: "deepseek-flash", autoPassed: false });
    expect(row.aiReview?.regions.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(
      regions.map(({ x, y, w, h }) => ({ x, y, w, h })),
    );
    expect(row.aiReview?.regions.map((r) => r.label).toSorted()).toEqual([
      "intended",
      "unintended",
    ]);
    expect(row.reviewState).toBe("pending");
    expect(build.status).toBe("changes");
  });

  test("an all-noise shot is only labelled when the project did not opt in", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    const { modelFetch } = stubModel();
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
    expect(row.aiReview?.regions.every((r) => r.label === "noise")).toBe(true);
    expect(row.aiReview?.autoPassed).toBe(false);
    expect(row.reviewState).toBe("pending");
    expect(build.status).toBe("changes");
  });

  test("an all-noise shot auto-passes when the project opted in, and the build passes", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { modelFetch } = stubModel();
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
    expect(row.aiReview?.autoPassed).toBe(true);
    expect(row).toMatchObject({ reviewState: "accepted", reviewedBy: null });
    expect(build.status).toBe("passed");
  });

  test("a shot whose size changed is labelled but never auto-passed: part of it was not measured", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { sent, modelFetch } = stubModel();
    const taller = shot({
      width: W,
      height: H + 40,
      blocks: [
        { ...TOP_LEFT, rgb: RED },
        { ...BOTTOM_RIGHT, rgb: RED },
      ],
    });
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: taller }] },
      { modelFetch },
    );
    const row = await onlyShot(ctx, build);
    expect(sent).toHaveLength(2);
    expect(row.diffResult?.sizeChanged).toBe(true);
    expect(row.aiReview?.regions.every((r) => r.label === "noise")).toBe(true);
    expect(row.aiReview?.autoPassed).toBe(false);
    expect(row.reviewState).toBe("pending");
    expect(build.status).toBe("changes");
  });

  test("one region that is not noise keeps the shot for a person, opted in or not", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { modelFetch } = stubModel((n) =>
      n === 0 ? "LABEL noise\nWHY Jitter." : "LABEL unintended\nWHY The button is clipped.",
    );
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
    expect(row.aiReview?.autoPassed).toBe(false);
    expect(row.reviewState).toBe("pending");
    expect(build.status).toBe("changes");
  });

  test("an answer in the wrong shape is a failed call, not a made-up label", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { modelFetch } = stubModel(() => "Looks fine to me!");
    const row = await onlyShot(ctx, await branchBuild(ctx, modelFetch));
    expect(row.aiReview).toBeNull();
    expect(row.reviewState).toBe("pending");
  });

  test("a shot with one region explained keeps that note and is never auto-passed", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { modelFetch } = stubModel((n) =>
      n === 0 ? "LABEL noise\nWHY Jitter." : new Error("500"),
    );
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
    expect(row.aiReview?.regions).toHaveLength(1);
    expect(row.aiReview?.autoPassed).toBe(false);
    expect(row.reviewState).toBe("pending");
    expect(build.status).toBe("changes");
  });

  test("with no model configured nothing is sent anywhere", async () => {
    const ctx = await context();
    const { sent, modelFetch } = stubModel();
    const build = await branchBuild(ctx, modelFetch);
    expect(sent).toHaveLength(0);
    expect((await onlyShot(ctx, build)).aiReview).toBeNull();
    expect(build.status).toBe("changes");
  });

  test("an unchanged shot is not sent", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { sent, modelFetch } = stubModel();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: white }] },
      { modelFetch },
    );
    expect(sent).toHaveLength(0);
  });

  test("a reviewer's decision made while the model was asked stands", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    let decided = false;
    const { modelFetch: answer } = stubModel();
    const modelFetch: ModelFetch = async (input, init) => {
      if (!decided && typeof init.body === "string" && init.body.includes("image_url")) {
        decided = true;
        const [row] = await ctx.db
          .select()
          .from(snapshots)
          .where(eq(snapshots.diffStatus, "changed"));
        await reviewSnapshot(ctx.db, {
          projectId: ctx.projectId,
          userId: ctx.userId,
          snapshotId: row?.id ?? "",
          state: "rejected",
        });
      }
      return answer(input, init);
    };
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
    expect(row).toMatchObject({ reviewState: "rejected", reviewedBy: ctx.userId, aiReview: null });
    expect(build.status).toBe("failed");
  });

  test("a re-run that measures the same keeps the explanation and asks nothing again", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    const first = stubModel();
    const build = await branchBuild(ctx, first.modelFetch);
    const row = await onlyShot(ctx, build);
    expect(row.aiReview).not.toBeNull();

    const again = stubModel();
    await explaining(
      { db: ctx.db, blobs: ctx.scoped, modelFetch: again.modelFetch },
      async (deps) => rerunShots(deps, await getBuild(ctx.db, ctx.projectId, build.id), row.id),
    );
    expect(again.sent).toHaveLength(0);
    expect((await onlyShot(ctx, build)).aiReview).toEqual(row.aiReview);
  });
});
