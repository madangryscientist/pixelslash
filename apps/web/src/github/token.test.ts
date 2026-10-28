import { describe, expect, test } from "vitest";
import { githubTokenConfigOf } from "./token";

describe("the GitHub token", () => {
  test("is configured only by a non-blank GITHUB_STATUS_TOKEN", () => {
    expect(githubTokenConfigOf({})).toBeNull();
    expect(githubTokenConfigOf({ GITHUB_STATUS_TOKEN: "  " })).toBeNull();
    expect(githubTokenConfigOf({ GITHUB_STATUS_TOKEN: " t " })).toEqual({
      token: "t",
      apiBase: "https://api.github.com",
    });
  });
});
