import { describe, expect, test } from "vitest";
import { ModelError, type ModelFetch, explainRegion, parseRegionAnswer } from "./model";

/** The model client (ob 1473): its parse, and that no error carries the key. */

const endpoint = { baseUrl: "http://model.test", model: "m", apiKey: "sk-secret-value" };
const images = {
  main: new Uint8Array([1]),
  branch: new Uint8Array([2]),
  diff: new Uint8Array([3]),
};

describe("parseRegionAnswer", () => {
  test("reads the two lines, in any case and with markdown around them", () => {
    expect(parseRegionAnswer("**LABEL:** Noise\nWHY: Text edges moved by a sub-pixel.")).toEqual({
      label: "noise",
      explanation: "Text edges moved by a sub-pixel.",
    });
  });

  test("an unknown label or a missing sentence is refused", () => {
    expect(() => parseRegionAnswer("LABEL bug\nWHY It broke.")).toThrow(ModelError);
    expect(() => parseRegionAnswer("LABEL noise")).toThrow(ModelError);
  });

  test("a long sentence is cut", () => {
    const { explanation } = parseRegionAnswer(`LABEL intended\nWHY ${"word ".repeat(200)}`);
    expect(explanation.length).toBeLessThanOrEqual(280);
    expect(explanation.endsWith("…")).toBe(true);
  });
});

const refused: ModelFetch = async () => new Response("bad key sk-secret-value", { status: 401 });
const down: ModelFetch = async () => {
  throw new Error("connect failed for sk-secret-value");
};

describe("explainRegion", () => {
  test("a refused call and an unreachable endpoint fail without the key in the message", async () => {
    for (const fetcher of [refused, down]) {
      const error = await explainRegion(endpoint, images, fetcher).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect(error instanceof Error ? error.message : "").not.toContain("sk-secret-value");
    }
  });
});
