import { Buffer } from "node:buffer";
import { cropBox } from "@pixelslash/engine/region-crops";
import { eq } from "drizzle-orm";
import { PNG } from "pngjs";
import { describe, expect, test, vi } from "vitest";
import { getBuild } from "#/db/builds";
import { setProjectModel } from "#/db/models";
import { reviewSnapshot } from "#/db/review";
import { snapshots } from "#/db/schema";
import { DIFF_BUDGET_MS } from "#/diff/budget";
import { rerunShots } from "#/diff/rerun";
import { type Ctx, context, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { ModelFetch } from "./model";

/**
 * Explaining changed regions with the project's own model (ob 1473), against a stubbed
 * OpenAI-compatible endpoint: nothing here reaches a real one.
 */

const W = 200;
const H = 100;
const TOP_LEFT = { x: 10, y: 10, w: 16, h: 12 };
const BOTTOM_RIGHT = { x: 150, y: 60, w: 20, h: 20 };
const white = shot({ width: W, height: H });
const twoChanges = shot({
  width: W,
  height: H,
  blocks: [
    { ...TOP_LEFT, rgb: RED },
    { ...BOTTOM_RIGHT, rgb: RED },
  ],
});

const BASE_URL = "http://model.test/v1";
const KEY = "sk-test-not-a-real-key";

type Sent = { url: string; auth: string | null; model: string; images: PNG[] };

/** An OpenAI-compatible endpoint that records each call and answers with `reply(call index)`. */
function stubModel(
  reply: (n: number) => string | Error | Response = () => "LABEL noise\nWHY Edges moved.",
) {
  const sent: Sent[] = [];
  const modelFetch: ModelFetch = async (input, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    const images = [...body.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(([, b64]) =>
      PNG.sync.read(Buffer.from(b64 ?? "", "base64")),
    );
    const headers = new Headers(init.headers);
    sent.push({
      url: input,
      auth: headers.get("authorization"),
      model: /"model":"([^"]+)"/.exec(body)?.[1] ?? "",
      images,
    });
    const answer = reply(sent.length - 1);
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return Response.json({ choices: [{ message: { role: "assistant", content: answer } }] });
  };
  return { sent, modelFetch };
}

async function withModel(ctx: Ctx, autoPassNoise: boolean) {
  await setProjectModel(ctx.db, ctx.userId, ctx.projectId, {
    baseUrl: BASE_URL,
    model: "deepseek-flash",
    apiKey: KEY,
    autoPassNoise,
  });
}

/** Main all white, then a branch build with two separate red blocks: two `change` regions. */
async function branchBuild(ctx: Ctx, modelFetch: ModelFetch) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  return upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
    { modelFetch },
  );
}

const pixel = (img: PNG, x: number, y: number) => {
  const at = (y * img.width + x) * 4;
  return [img.data[at], img.data[at + 1], img.data[at + 2]];
};

describe("explaining changed regions (ob 1473)", () => {
  test("one call per change region, each with that region's three crops only", async () => {
    const ctx = await context();
    await withModel(ctx, false);
    const { sent, modelFetch } = stubModel((n) =>
      n === 0 ? "LABEL intended\nWHY A red block was added." : "LABEL unintended\nWHY Overlap.",
    );
    const build = await branchBuild(ctx, modelFetch);
    const row = await onlyShot(ctx, build);
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

  test("a diff that used the run's budget leaves nothing for the model", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { sent, modelFetch } = stubModel();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    // Each reading of the clock is a second later; the diff's reads are enough to spend the budget.
    let t = 0;
    const now = () => (t += DIFF_BUDGET_MS / 4);
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: twoChanges }] },
      { modelFetch, now },
    );
    expect(sent).toHaveLength(0);
    expect((await onlyShot(ctx, build)).aiReview).toBeNull();
    expect(build).toMatchObject({ status: "changes", error: null });
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

  test("a failed call stores no explanation and the build still gets its verdict", async () => {
    const ctx = await context();
    await withModel(ctx, true);
    const { sent, modelFetch } = stubModel(() => new Response("nope", { status: 401 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const build = await branchBuild(ctx, modelFetch);
    expect(sent).toHaveLength(2);
    // One line per build says why, so a wrong key can be found; it never carries the key.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("the model answered 401");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEY);
    warn.mockRestore();
    const row = await onlyShot(ctx, build);
    expect(row.aiReview).toBeNull();
    expect(row.reviewState).toBe("pending");
    expect(build).toMatchObject({ status: "changes", error: null });
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
      if (!decided) {
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
    const decided = await getBuild(ctx.db, ctx.projectId, build.id);
    await rerunShots(
      { db: ctx.db, blobs: ctx.scoped, modelFetch: again.modelFetch },
      decided,
      row.id,
    );
    expect(again.sent).toHaveLength(0);
    expect((await onlyShot(ctx, build)).aiReview).toEqual(row.aiReview);
  });
});
