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

const replying =
  (choice: object): ModelFetch =>
  async () =>
    Response.json({ choices: [choice] });
const errorOf = async (fetcher: ModelFetch) => {
  const e = await explainRegion(endpoint, images, { buildId: "build-1", fetcher }).catch(
    (x: unknown) => x,
  );
  return e instanceof Error ? e.message : "";
};

describe("a reply cut off by the token ceiling (ob 1833)", () => {
  const RAN_OUT = "the model ran out of tokens before answering (finish_reason length)";

  test("empty, null or missing content with finish_reason length names the cause", async () => {
    for (const message of [{ content: "" }, { content: null }, { content: "  " }, {}]) {
      expect(await errorOf(replying({ finish_reason: "length", message }))).toBe(RAN_OUT);
    }
  });

  test("kimi's null content beside reasoning_content is no content, not a crash", async () => {
    const message = { content: null, reasoning_content: "Let me think about the images…" };
    expect(await errorOf(replying({ finish_reason: "length", message }))).toBe(RAN_OUT);
    expect(await errorOf(replying({ finish_reason: "stop", message }))).toBe(
      "the reply had no message content",
    );
  });

  test("a normal two-line reply still parses", async () => {
    const fetcher = replying({
      finish_reason: "stop",
      message: { content: "LABEL noise\nWHY Edges moved." },
    });
    expect(await explainRegion(endpoint, images, { buildId: "build-1", fetcher })).toEqual({
      label: "noise",
      explanation: "Edges moved.",
    });
  });
});

describe("explainRegion", () => {
  test("a refused call and an unreachable endpoint fail without the key in the message", async () => {
    for (const fetcher of [refused, down]) {
      const error = await explainRegion(endpoint, images, { buildId: "build-1", fetcher }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ModelError);
      expect(error instanceof Error ? error.message : "").not.toContain("sk-secret-value");
    }
  });
});

/** The headers one call sends, as the stub endpoint saw them. */
async function headersSentTo(baseUrl: string, buildId: string) {
  let seen: Headers | null = null;
  const fetcher: ModelFetch = async (_url, init) => {
    seen = new Headers(init.headers);
    return Response.json({ choices: [{ message: { content: "LABEL noise\nWHY Moved." } }] });
  };
  await explainRegion({ ...endpoint, baseUrl }, images, { buildId, fetcher });
  if (!seen) throw new Error("no call was made");
  return seen as Headers;
}

describe("the headers of a model call (ob 1794)", () => {
  test("OpenCode Go gets a named client and the build's session id", async () => {
    const headers = await headersSentTo("https://opencode.ai/inference/go/openai/v1", "build-7");
    expect(headers.get("user-agent")).toMatch(/^pixelslash\/\d+\.\d+\.\d+/);
    expect(headers.get("x-opencode-session")).toBe("build-7");
    expect(headers.get("authorization")).toBe("Bearer sk-secret-value");
  });

  test("any other endpoint, or a look-alike host, gets the named client and no session header", async () => {
    const headers = await headersSentTo("https://api.deepseek.com", "build-7");
    expect(headers.get("user-agent")).toMatch(/^pixelslash\//);
    expect(headers.has("x-opencode-session")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer sk-secret-value");
    const lookAlike = await headersSentTo("https://opencode.ai.example.com/v1", "build-7");
    expect(lookAlike.has("x-opencode-session")).toBe(false);
  });
});
