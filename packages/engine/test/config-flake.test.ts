import { describe, expect, test } from "vitest";
import { parseConfig, resolveFlaky } from "../src/config.ts";

const base = { baseUrl: "http://127.0.0.1:3000", routes: ["/"] };

describe("resolveFlaky (ob 1737)", () => {
  test("nothing set is review, with 2 retries", () => {
    const config = parseConfig(base);
    expect(config.flake).toEqual({ retries: 2 });
    expect(resolveFlaky(config, config.routes[0]!)).toBe("review");
  });

  test("the project default applies to a route that sets none; a route's own wins", () => {
    const config = parseConfig({
      ...base,
      flaky: "skip",
      flake: { retries: 0 },
      routes: ["/", { path: "/clock", flaky: "review" }],
    });
    expect(config.flake.retries).toBe(0);
    expect(config.routes.map((r) => resolveFlaky(config, r))).toEqual(["skip", "review"]);
  });

  test("a route can opt out on its own", () => {
    const config = parseConfig({ ...base, routes: ["/", { path: "/ad", flaky: "skip" }] });
    expect(config.routes.map((r) => resolveFlaky(config, r))).toEqual(["review", "skip"]);
  });
});

describe("flaky and flake are validated with their path (ob 1737)", () => {
  test.each([
    [{ ...base, flaky: "ignore" }, /flaky must be "review" or "skip"/],
    [
      { ...base, routes: [{ path: "/", flaky: true }] },
      /routes\[0\]\.flaky must be "review" or "skip"/,
    ],
    [{ ...base, flake: { retries: -1 } }, /flake\.retries must be a non-negative integer/],
    [{ ...base, flake: { retries: 1.5 } }, /flake\.retries must be a non-negative integer/],
    [{ ...base, flake: { tries: 2 } }, /flake\.tries is not a flake option \(retries\)/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(message);
  });
});
