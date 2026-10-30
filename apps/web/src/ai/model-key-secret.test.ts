import { describe, expect, test, vi } from "vitest";
import { setProjectModel } from "#/db/models";
import { TEST_MODEL_KEY_SECRET } from "#/db/test-db";
import { context, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { ModelFetch } from "./model";

/** A server without `MODEL_KEY_SECRET` cannot open a project's sealed model key (ob 1786). */

const KEY = "sk-test-not-a-real-key";
const white = shot({ width: 200, height: 100 });
const changed = shot({
  width: 200,
  height: 100,
  blocks: [{ x: 10, y: 10, w: 16, h: 12, rgb: RED }],
});

describe("a project's sealed model key on a server without its secret", () => {
  test("asks no model, reviews plain pixels, and logs no key", async () => {
    const ctx = await context();
    await setProjectModel(ctx.db, ctx.userId, ctx.projectId, {
      baseUrl: "http://model.test/v1",
      model: "deepseek-flash",
      apiKey: KEY,
      autoPassNoise: true,
      modelKeySecret: TEST_MODEL_KEY_SECRET,
      modelHosts: { allowPrivate: true },
    });
    const asked: string[] = [];
    const modelFetch: ModelFetch = async (input) => {
      asked.push(input);
      return Response.json({ choices: [{ message: { content: "LABEL noise\nWHY x" } }] });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
      const build = await upload(
        ctx,
        { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: changed }] },
        { modelFetch, modelKeySecret: null },
      );
      expect(asked).toEqual([]);
      const row = await onlyShot(ctx, build);
      expect(row.diffStatus).toBe("changed");
      expect(row.aiReview).toBeNull();
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain("MODEL_KEY_SECRET is not set");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    } finally {
      warn.mockRestore();
    }
  });
});
