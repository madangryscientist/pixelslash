import { describe, expect, test } from "vitest";
import { tally, usageOf } from "./usage";

describe("usageOf", () => {
  test("reads the reply's prompt, completion and total tokens", () => {
    const body = { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 15 } };
    expect(usageOf(body)).toEqual({ input: 10, output: 4, total: 15 });
  });

  test("sums the two counts when the reply sent no total", () => {
    expect(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 4 } })).toEqual({
      input: 10,
      output: 4,
      total: 14,
    });
  });

  test("is null, never an estimate, when a count is missing or not a count", () => {
    expect(usageOf({})).toBeNull();
    expect(usageOf(null)).toBeNull();
    expect(usageOf({ usage: { prompt_tokens: 10 } })).toBeNull();
    expect(usageOf({ usage: { prompt_tokens: "10", completion_tokens: 4 } })).toBeNull();
    expect(usageOf({ usage: { prompt_tokens: -1, completion_tokens: 4 } })).toBeNull();
  });
});

describe("tally", () => {
  test("counts every stored answer and sums only the reported ones", () => {
    const u = { input: 10, output: 4, total: 14 };
    expect(tally([u, null, u])).toEqual({ calls: 3, reported: 2, input: 20, output: 8, total: 28 });
    expect(tally([null])).toEqual({
      calls: 1,
      reported: 0,
      input: null,
      output: null,
      total: null,
    });
  });
});
