import { describe, expect, test } from "vitest";
import { GithubError, TOKEN_REFRESH_MS, githubAppConfigOf, repoNameOf } from "./app";
import { fakeGithub } from "./test-github";

const tokenCalls = (calls: { path: string }[]) =>
  calls.filter((c) => c.path.endsWith("/installation") || c.path.endsWith("/access_tokens"));

describe("the App's installation token", () => {
  test("is minted once with the App JWT, then reused for the repo's calls", async () => {
    const github = fakeGithub();
    const app = github.app();

    await app.request("acme/web", "PATCH", "/repos/acme/web/check-runs/1", {});
    await app.request("acme/web", "PATCH", "/repos/acme/web/check-runs/1", {});

    expect(github.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/acme/web/installation",
      "POST /app/installations/77/access_tokens",
      "PATCH /repos/acme/web/check-runs/1",
      "PATCH /repos/acme/web/check-runs/1",
    ]);
    // The App JWT finds the installation and mints; the installation token makes the calls.
    expect(github.calls[0]?.auth).toMatch(/^Bearer ey/);
    expect(github.calls[1]?.raw).toBe(JSON.stringify({ repositories: ["web"] }));
    expect(github.calls[2]?.auth).toBe("Bearer ghs_token1");
    expect(github.calls[3]?.auth).toBe("Bearer ghs_token1");
  });

  test("is minted again once it is within the refresh margin of expiring", async () => {
    let clock = Date.parse("2026-10-27T10:00:00Z");
    const github = fakeGithub({ now: () => clock });
    const app = github.app();
    const patch = () => app.request("acme/web", "PATCH", "/repos/acme/web/check-runs/1", {});

    await patch();
    // The token lives an hour: just short of the margin it is still good.
    clock += 60 * 60_000 - TOKEN_REFRESH_MS - 1000;
    await patch();
    expect(tokenCalls(github.calls)).toHaveLength(2);

    clock += 2000;
    await patch();
    expect(tokenCalls(github.calls)).toHaveLength(4);
    expect(github.calls.at(-1)?.auth).toBe("Bearer ghs_token2");
  });

  test("is dropped on a 401, so the next call mints a new one", async () => {
    const github = fakeGithub();
    const app = github.app();
    const patch = () => app.request("acme/web", "PATCH", "/repos/acme/web/check-runs/1", {});
    await patch();

    github.setMode({ status: 401 });
    await expect(patch()).rejects.toBeInstanceOf(GithubError);
    github.setMode("ok");
    await patch();

    expect(github.calls.at(-1)?.auth).toBe("Bearer ghs_token2");
  });

  test("is cached per repo", async () => {
    const github = fakeGithub();
    const app = github.app();
    await app.request("acme/web", "PATCH", "/repos/acme/web/check-runs/1", {});
    await app.request("acme/docs", "PATCH", "/repos/acme/docs/check-runs/2", {});
    await app.request("Acme/Web", "PATCH", "/repos/Acme/Web/check-runs/1", {});
    expect(tokenCalls(github.calls)).toHaveLength(4);
  });

  test("a GitHub that does not answer is given up on at the timeout", async () => {
    const github = fakeGithub();
    github.setMode("hang");
    const app = github.app({ timeoutMs: 20 });
    await expect(app.request("acme/web", "GET", "/repos/acme/web")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("the App's config", () => {
  test("is off unless both the id and the key are set", () => {
    expect(githubAppConfigOf({})).toBeNull();
    expect(githubAppConfigOf({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "" })).toBeNull();
    expect(githubAppConfigOf({ GITHUB_APP_ID: " ", GITHUB_APP_PRIVATE_KEY: "k" })).toBeNull();
    expect(githubAppConfigOf({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" })).toEqual({
      appId: "1",
      privateKey: "k",
      apiBase: "https://api.github.com",
    });
  });

  test("uses GITHUB_APP_API_BASE when set, and GITHUB_API_BASE when it is empty", () => {
    const app = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      GITHUB_API_BASE: "http://localhost:4174",
    };
    expect(
      githubAppConfigOf({ ...app, GITHUB_APP_API_BASE: "https://api.github.com" })?.apiBase,
    ).toBe("https://api.github.com");
    expect(githubAppConfigOf({ ...app, GITHUB_APP_API_BASE: "" })?.apiBase).toBe(
      "http://localhost:4174",
    );
    expect(githubAppConfigOf({ ...app, GITHUB_APP_API_BASE: "  " })?.apiBase).toBe(
      "http://localhost:4174",
    );
    expect(githubAppConfigOf(app)?.apiBase).toBe("http://localhost:4174");
  });
});

describe("a repo name", () => {
  test("is owner/name as GitHub spells it", () => {
    expect(repoNameOf(" acme/web ")).toBe("acme/web");
    expect(repoNameOf("a-b/c.d_e")).toBe("a-b/c.d_e");
    for (const bad of ["acme", "acme/", "/web", "acme/web/x", "-acme/web", "acme/..", "ac me/web"])
      expect(repoNameOf(bad)).toBeNull();
  });
});
