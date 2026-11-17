import { describe, expect, test } from "vitest";
import { EmailInUseError } from "#/db/users";
import { type GoogleConfig, UnverifiedEmailError } from "./google";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  type GoogleCallbackDeps,
  googleCallback,
  googleStart,
} from "./sign-in-google";
import { fakeJar, fakeLimiter, request } from "./sign-in-test-kit";

const config: GoogleConfig = {
  clientId: "cid",
  clientSecret: "secret",
  authorizeUrl: "https://google.test/authorize",
  tokenUrl: "https://google.test/token",
  userinfoUrl: "https://google.test/userinfo",
};

const TAMPERED = "Sign-in expired or was tampered with. Try again.";
const both = { [GOOGLE_STATE_COOKIE]: "s1", [GOOGLE_VERIFIER_COOKIE]: "v1" };
const clearedBoth = [
  { name: GOOGLE_STATE_COOKIE, options: { path: "/auth/google" } },
  { name: GOOGLE_VERIFIER_COOKIE, options: { path: "/auth/google" } },
];

/** Callback deps over a cookie jar; the calls that must not happen are counted. */
function callbackDeps(cookies: Record<string, string>, over: Partial<GoogleCallbackDeps> = {}) {
  const jar = fakeJar(cookies);
  const calls = { fetchProfile: 0, signInUser: 0, startSession: [] as string[] };
  const deps: GoogleCallbackDeps = {
    limiter: undefined,
    config: () => config,
    getCookie: jar.getCookie,
    deleteCookie: jar.deleteCookie,
    fetchProfile: async () => {
      calls.fetchProfile += 1;
      return { sub: "1", email: "ada@example.com", name: "Ada", avatarUrl: null };
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

describe("google callback: the state check", () => {
  const cases = [
    { name: "a missing code", cookies: both, url: "/auth/google/callback?state=s1" },
    {
      name: "a missing state cookie",
      cookies: { [GOOGLE_VERIFIER_COOKIE]: "v1" },
      url: "/auth/google/callback?code=c&state=s1",
    },
    {
      name: "a missing verifier cookie",
      cookies: { [GOOGLE_STATE_COOKIE]: "s1" },
      url: "/auth/google/callback?code=c&state=s1",
    },
    { name: "a missing query state", cookies: both, url: "/auth/google/callback?code=c" },
    { name: "a mismatched state", cookies: both, url: "/auth/google/callback?code=c&state=s2" },
  ];

  test.each(cases)("$name is refused, starts no session and clears both cookies", async (c) => {
    const { deps, jar, calls } = callbackDeps(c.cookies);
    const res = await googleCallback(request(c.url), deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(TAMPERED);
    expect(calls).toEqual({ fetchProfile: 0, signInUser: 0, startSession: [] });
    expect(jar.deleted).toEqual(clearedBoth);
  });

  test("a matching state trades the code, starts the session and clears both cookies", async () => {
    const { deps, jar, calls } = callbackDeps(both);
    const res = await googleCallback(request("/auth/google/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/orgs");
    expect(calls.startSession).toEqual(["user-1"]);
    expect(jar.deleted).toEqual(clearedBoth);
  });

  test("a consent turned down goes back to the sign-in page and starts no session", async () => {
    const { deps, jar, calls } = callbackDeps(both);
    const res = await googleCallback(
      request("/auth/google/callback?error=access_denied&state=other"),
      deps,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(calls).toEqual({ fetchProfile: 0, signInUser: 0, startSession: [] });
    expect(jar.deleted).toEqual(clearedBoth);
  });

  test("an unverified email is a 400 page and starts no session", async () => {
    const { deps, calls } = callbackDeps(both, {
      fetchProfile: async () => {
        throw new UnverifiedEmailError("Your Google email is not verified.");
      },
    });
    const res = await googleCallback(request("/auth/google/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "Your Google email is not verified. Verify it with Google, then try again.",
    );
    expect(calls.startSession).toEqual([]);
  });

  test("an email already used by another sign-in is a 409 page and starts no session", async () => {
    const { deps, calls } = callbackDeps(both, {
      signInUser: async () => {
        throw new EmailInUseError("That email belongs to another account.");
      },
    });
    const res = await googleCallback(request("/auth/google/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      "That email belongs to another account. Sign in with GitHub instead.",
    );
    expect(calls.startSession).toEqual([]);
  });

  test("any other failure is not swallowed", async () => {
    const { deps } = callbackDeps(both, {
      fetchProfile: async () => {
        throw new Error("token exchange failed");
      },
    });
    await expect(
      googleCallback(request("/auth/google/callback?code=c&state=s1"), deps),
    ).rejects.toThrow("token exchange failed");
  });
});

describe("google sign-in: no Google client", () => {
  test("both routes are a 404 and ask no limiter", async () => {
    const limiter = fakeLimiter(0);
    const jar = fakeJar({});
    const start = await googleStart(request("/auth/google"), {
      limiter,
      config: () => null,
      setCookie: jar.setCookie,
    });
    const { deps } = callbackDeps(both, { limiter, config: () => null });
    const callback = await googleCallback(request("/auth/google/callback"), deps);
    expect([start.status, callback.status]).toEqual([404, 404]);
    expect(limiter.keys).toEqual([]);
    expect(jar.set).toEqual([]);
  });
});

describe("google sign-in: the rate limit", () => {
  test("the start route answers the limited response and sets nothing when refused", async () => {
    const limiter = fakeLimiter(0);
    const jar = fakeJar({});
    const res = await googleStart(request("/auth/google", "9.9.9.9"), {
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
    const res = await googleStart(request("/auth/google", "9.9.9.9"), {
      limiter: fakeLimiter(1),
      config: () => config,
      setCookie: jar.setCookie,
    });
    expect(res.status).toBe(302);
    expect(jar.set.map((c) => [c.name, c.options.path])).toEqual([
      [GOOGLE_STATE_COOKIE, "/auth/google"],
      [GOOGLE_VERIFIER_COOKIE, "/auth/google"],
    ]);
    expect(res.headers.get("location")).toContain(`state=${jar.set[0]?.value}`);
  });

  test("the callback answers the limited response and does nothing else when refused", async () => {
    const limiter = fakeLimiter(0);
    const { deps, jar, calls } = callbackDeps(both, { limiter });
    const res = await googleCallback(
      request("/auth/google/callback?code=c&state=s1", "9.9.9.9"),
      deps,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(jar.deleted).toEqual([]);
    expect(calls).toEqual({ fetchProfile: 0, signInUser: 0, startSession: [] });
    expect(limiter.keys).toEqual(["ip:9.9.9.9"]);
  });

  test("the callback proceeds when allowed", async () => {
    const { deps, calls } = callbackDeps(both, { limiter: fakeLimiter(1) });
    const res = await googleCallback(request("/auth/google/callback?code=c&state=s1"), deps);
    expect(res.status).toBe(302);
    expect(calls.startSession).toEqual(["user-1"]);
  });

  test("two addresses are counted apart", async () => {
    const limiter = fakeLimiter(1);
    const go = async (ip: string) => {
      const { deps } = callbackDeps({}, { limiter });
      return (await googleCallback(request("/auth/google/callback", ip), deps)).status;
    };
    expect(await go("1.1.1.1")).toBe(400);
    expect(await go("1.1.1.1")).toBe(429);
    expect(await go("2.2.2.2")).toBe(400);
    expect(limiter.keys).toEqual(["ip:1.1.1.1", "ip:1.1.1.1", "ip:2.2.2.2"]);
  });
});
