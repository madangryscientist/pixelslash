import { describe, expect, test } from "vitest";
import { buildKind, githubStubRefusal } from "./stub-guard";

/** The GitHub stand-in is refused outside dev and the test build (PS-250). */

const github = {
  GITHUB_OAUTH_BASE: "https://github.com",
  GITHUB_API_BASE: "https://api.github.com",
};
const stub = {
  GITHUB_OAUTH_BASE: "http://localhost:4174",
  GITHUB_API_BASE: "http://localhost:4174",
};

describe("githubStubRefusal", () => {
  test("a production build pointed anywhere but GitHub is refused, naming the bases", () => {
    expect(githubStubRefusal("production", stub)).toMatch(
      /refusing to start: GITHUB_OAUTH_BASE is http:\/\/localhost:4174/,
    );
    expect(
      githubStubRefusal("production", { ...github, GITHUB_API_BASE: "http://10.0.0.1" }),
    ).not.toBeNull();
    expect(githubStubRefusal("production", {})).toMatch(/is unset/);
  });

  test("a production build pointed at GitHub starts, a trailing slash or not", () => {
    expect(githubStubRefusal("production", github)).toBeNull();
    expect(
      githubStubRefusal("production", {
        GITHUB_OAUTH_BASE: "https://github.com/",
        GITHUB_API_BASE: "https://api.github.com/",
      }),
    ).toBeNull();
  });

  test("a dev server and the test build may use the stand-in", () => {
    expect(githubStubRefusal("dev", stub)).toBeNull();
    expect(githubStubRefusal("test", stub)).toBeNull();
  });

  test("a build vite did not name is production", () => {
    expect(buildKind()).toBe("production");
  });
});
