import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const base = { baseUrl: "http://127.0.0.1:3000", routes: ["/"] };
const SB = "http://127.0.0.1:6007";

describe("the storybook config", () => {
  test("fills its defaults and stands in for baseUrl and routes", () => {
    const config = parseConfig({
      storybook: { url: SB, globals: { theme: ["none", "dark"] } },
      masks: [".clock"],
      tags: ["sb"],
      start: { command: "bun e2e/serve.ts" },
    });
    expect(config.baseUrl).toBe(SB);
    expect(config.routes).toEqual([]);
    expect(config.start?.readyUrl).toBe(SB);
    expect(config.storybook).toEqual({
      url: SB,
      globals: { theme: ["none", "dark"] },
      include: ["**"],
      exclude: [],
      masks: [".clock"],
      tags: ["sb"],
    });
    expect(parseConfig(base).storybook).toBeUndefined();
  });

  test("keeps an explicit baseUrl and hand-written routes beside it", () => {
    const config = parseConfig({ ...base, storybook: { url: SB } });
    expect(config.baseUrl).toBe(base.baseUrl);
    expect(config.routes.map((r) => r.name)).toEqual(["index"]);
    expect(config.storybook?.globals).toEqual({});
  });

  test.each([
    [{ ...base, storybook: { url: "ftp://x" } }, /storybook\.url must be an http\(s\) URL/],
    [{ ...base, storybook: { url: SB, glob: [] } }, /storybook\.glob is not a storybook option/],
    [{ ...base, storybook: { url: SB, globals: [] } }, /storybook\.globals must be an object/],
    [
      { ...base, storybook: { url: SB, globals: { theme: [] } } },
      /storybook\.globals\.theme must be a non-empty array/,
    ],
    [
      { ...base, storybook: { url: SB, globals: { theme: ["a;b"] } } },
      /storybook\.globals\.theme\[0\] must not contain : or ;/,
    ],
    [
      { ...base, storybook: { url: SB, globals: { theme: ["a", "a"] } } },
      /storybook\.globals\.theme lists a value twice/,
    ],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(message);
  });
});
