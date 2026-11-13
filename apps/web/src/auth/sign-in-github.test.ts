import { describe, expect, test } from "vitest";
import type { GithubConfig } from "./github";
import {
  type GithubCallbackDeps,
  OAUTH_STATE_COOKIE,
  githubCallback,
  githubStart,
} from "./sign-in-github";
import { fakeLimiter, fakeJar, request } from "./sign-in-test-kit";

const config: GithubConfig = {
  clientId: "cid",
  clientSecret: "secret",
  oauthBase: "https://github.test",
  apiBase: "https://api.github.test",
};

const TAMPERED = "Sign-in expired or was tampered with. Try again.";

/** Callback deps over a cookie jar; the calls that must not happen are counted. */
function callbackDeps(cookies: Record<string, string>, over: Partial<GithubCallbackDeps> = {}) {
  const jar = fakeJar(cookies);
  const calls = { fetchProfile: 0, signInUser: 0, startSession: [] as string[] };
  const deps: GithubCallbackDeps = {
    limiter: undefined,
    config: () => config,
    getCookie: jar.getCookie,
    deleteCookie: jar.deleteCookie,
    fetchProfile: async () => {
      calls.fetchProfile += 1;
      return { githubId: 1, login: "ada", name: null, avatarUrl: null };
    },
    signInUser: async () => {
      calls.signInUser += 1;
      return "user-1";
    },
    startSession: async (id) => {
      calls.startSession.push(id);
    },
    ...over,
  };
  return { deps, jar, calls };
}

describe("github callback: the state check", () => {
  const cases = [
    { name: "a missing code", cookie: "s1", url: "/auth/github/callback?state=s1" },
    {
      name: "a missing state cookie",
      cookie: undefined,
      url: "/auth/github/callback?code=c&state=s1",
    },
    { name: "a missing query state", cookie: "s1", url: "/auth/github/callback?code=c" },
    { name: "a mismatched state", cookie: "s1", url: "/auth/github/callback?code=c&state=s2" },
  ];

  test.each(cases)("$name is refused, starts no session and clears the state cookie", async (c) => {
    const { deps, jar, calls } = callbackDeps(c.cookie ? { [OAUTH_STATE_COOKIE]: c.cookie } : {});
    const res = await githubCallback(request(c.url), deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(TAMPERED);
    expect(calls).toEqual({ fetchProfile: 0, signInUser: 0, startSession: [] });
    expect(jar.deleted).toEqual([{ name: OAUTH_STATE_COOKIE, options: { path: "/auth/github" } }]);
  });

  test("a matching state trades the code, starts the session and clears the cookie", async () => {
    const { deps, jar, calls } = callbackDeps({ [OAUTH_STATE_COOKIE]: "s1" });
    const res = await githubCallback(request("/auth/github/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/orgs");
    expect(calls.startSession).toEqual(["user-1"]);
    expect(jar.deleted).toEqual([{ name: OAUTH_STATE_COOKIE, options: { path: "/auth/github" } }]);
  });
});

describe("github sign-in: the rate limit", () => {
  test("the start route answers the limited response and sets nothing when refused", async () => {
    const limiter = fakeLimiter(0);
    const jar = fakeJar({});
    const res = await githubStart(request("/auth/github", "9.9.9.9"), {
      limiter,
      config: () => config,
      setCookie: jar.setCookie,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(jar.set).toEqual([]);
    expect(limiter.keys).toEqual(["ip:9.9.9.9"]);
  });

  test("the start route proceeds when allowed", async () => {
    const jar = fakeJar({});
    const res = await githubStart(request("/auth/github", "9.9.9.9"), {
      limiter: fakeLimiter(1),
      config: () => config,
      setCookie: jar.setCookie,
    });
    expect(res.status).toBe(302);
    const state = jar.set[0]?.value;
    expect(jar.set[0]).toMatchObject({
      name: OAUTH_STATE_COOKIE,
      options: { httpOnly: true, sameSite: "lax", path: "/auth/github", maxAge: 600 },
    });
    expect(res.headers.get("location")).toContain(`state=${state}`);
  });

  test("the callback answers the limited response and does nothing else when refused", async () => {
    const limiter = fakeLimiter(0);
    const { deps, jar, calls } = callbackDeps({ [OAUTH_STATE_COOKIE]: "s1" }, { limiter });
    const res = await githubCallback(
      request("/auth/github/callback?code=c&state=s1", "9.9.9.9"),
      deps,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(jar.deleted).toEqual([]);
    expect(calls).toEqual({ fetchProfile: 0, signInUser: 0, startSession: [] });
    expect(limiter.keys).toEqual(["ip:9.9.9.9"]);
  });

  test("the callback proceeds when allowed", async () => {
    const { deps, calls } = callbackDeps(
      { [OAUTH_STATE_COOKIE]: "s1" },
      { limiter: fakeLimiter(1) },
    );
    const res = await githubCallback(request("/auth/github/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(302);
    expect(calls.startSession).toEqual(["user-1"]);
  });

  test("two addresses are counted apart", async () => {
    const limiter = fakeLimiter(1);
    const go = async (ip: string) => {
      const { deps } = callbackDeps({}, { limiter });
      return (await githubCallback(request("/auth/github/callback", ip), deps)).status;
    };
    expect(await go("1.1.1.1")).toBe(400);
    expect(await go("1.1.1.1")).toBe(429);
    expect(await go("2.2.2.2")).toBe(400);
    expect(limiter.keys).toEqual(["ip:1.1.1.1", "ip:1.1.1.1", "ip:2.2.2.2"]);
  });
});
