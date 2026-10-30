import { diffPngs, summarizeDiff } from "@pixelslash/engine/diff";
import { describe, expect, test } from "vitest";
import { parseCiInput, pngSize } from "#/api/validate";
import { CiResultError, type CiUpload, checkCiResult } from "./ci-result";
import { RED, shot } from "./test-shots";

/** The checks a CI result passes before it is stored (ob 1727), on a real engine result. */

const main = shot();
const branch = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const real = summarizeDiff(diffPngs(Buffer.from(main), Buffer.from(branch), {}));

function upload(diffResult: unknown, status: unknown = "changed"): CiUpload {
  return {
    engineVersion: "0.1.0",
    image: pngSize(branch.buffer),
    results: [{ baselineId: "b", status, diffResult, diffKey: "k" }],
  };
}

/** The baseline the server settled on: `b`, the size of `main`'s own header. */
const b = { id: "b", size: pngSize(main.buffer) };
const check = (u: unknown) => () => checkCiResult(u, b, {});

describe("checkCiResult", () => {
  test("the engine's own result passes and is stored as sent", () => {
    expect(checkCiResult(upload(real), b, {})).toMatchObject({ changed: true, diffKey: "k" });
  });

  test.each([
    ["nothing sent", null, /^no result/],
    ["a result for another baseline", { ...upload(real), results: [] }, /^no result/],
    ["a status the counts do not give", upload(real, "unchanged"), /does not follow/],
    ["a status that is not one", upload(real, "maybe"), /status must be/],
    [
      "a region outside the image",
      upload({ ...real, regions: [{ ...real.regions[0], x: 60 }] }),
      /outside/,
    ],
    [
      "more changed pixels than the image",
      upload({ ...real, changedPixels: 1e6 }),
      /exceed the overlap/,
    ],
    ["another shot's size", upload({ ...real, branchWidth: 65 }), /branch size/],
    [
      "another baseline's size",
      upload({ ...real, mainHeight: 47 }),
      /main size .* baseline's 64x48/,
    ],
  ])("refuses %s", (_what, sent, reason) => {
    expect(check(sent)).toThrow(CiResultError);
    expect(check(sent)).toThrow(reason);
  });

  test("a result for a baseline the server did not pick is stale", () => {
    expect(() => checkCiResult(upload(real), { ...b, id: "other" }, {})).toThrow(/^stale baseline/);
  });
});

describe("the upload's ci field", () => {
  test("is optional, and refuses an empty list or a baseline named twice", () => {
    expect(parseCiInput(undefined)).toBeNull();
    const r = { baselineId: "b", status: "changed", diffResult: {} };
    expect(() => parseCiInput({ engineVersion: "0.1.0", results: [] })).toThrow(/1 to/);
    expect(() => parseCiInput({ engineVersion: "0.1.0", results: [r, r] })).toThrow(/twice/);
  });

  test("the shot's size is read from its PNG header", () => {
    expect(pngSize(branch.buffer)).toEqual({ width: 64, height: 48 });
    expect(() => pngSize(new ArrayBuffer(8))).toThrow(/too short/);
  });
});
