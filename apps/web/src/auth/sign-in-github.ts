import type { GithubProfile } from "#/db/users";
import { randomToken } from "#/lib/crypto";
import { type RateLimiter, ipKey, overLimit, signInLimited } from "#/server/rate-limit";
import { type GithubConfig, authorizeUrl } from "./github";

export const OAUTH_STATE_COOKIE = "ps_oauth_state";

export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/** What the GitHub sign-in routes need from the server, passed in so a test can stand in for it. */
export type GithubStartDeps = {
  limiter: RateLimiter | undefined;
  config: () => GithubConfig;
  setCookie: (name: string, value: string, options: CookieOptions) => void;
};

export type GithubCallbackDeps = {
  limiter: RateLimiter | undefined;
  config: () => GithubConfig;
  getCookie: (name: string) => string | undefined;
  deleteCookie: (name: string, options: { path: string }) => void;
  fetchProfile: (config: GithubConfig, code: string, callback: string) => Promise<GithubProfile>;
  /** Saves the profile and answers the user's id. */
  signInUser: (profile: GithubProfile) => Promise<string>;
  startSession: (userId: string) => Promise<void>;
};

/** `/auth/github`: remember a fresh `state` in a cookie and send the browser to GitHub. */
export async function githubStart(request: Request, deps: GithubStartDeps): Promise<Response> {
  if (await overLimit(deps.limiter, ipKey(request))) return signInLimited();
  const url = new URL(request.url);
  const state = randomToken("");
  deps.setCookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: "/auth/github",
    maxAge: 600,
  });
  const callback = new URL("/auth/github/callback", url).toString();
  const location = authorizeUrl(deps.config(), state, callback);
  return new Response(null, { status: 302, headers: { location } });
}

/** `/auth/github/callback`: the `state` must come back as the cookie said, then the session starts. */
export async function githubCallback(
  request: Request,
  deps: GithubCallbackDeps,
): Promise<Response> {
  if (await overLimit(deps.limiter, ipKey(request))) return signInLimited();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = deps.getCookie(OAUTH_STATE_COOKIE);
  deps.deleteCookie(OAUTH_STATE_COOKIE, { path: "/auth/github" });
  if (!code || !state || url.searchParams.get("state") !== state)
    return new Response("Sign-in expired or was tampered with. Try again.", { status: 400 });
  const callback = new URL(url.pathname, url).toString();
  const profile = await deps.fetchProfile(deps.config(), code, callback);
  await deps.startSession(await deps.signInUser(profile));
  return new Response(null, { status: 302, headers: { location: "/orgs" } });
}
