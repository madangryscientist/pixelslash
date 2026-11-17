import { EmailInUseError, type GoogleProfile } from "#/db/users";
import { randomToken } from "#/lib/crypto";
import { type RateLimiter, ipKey, overLimit, signInLimited } from "#/server/rate-limit";
import type { CookieOptions } from "./sign-in-github";
import { type GoogleConfig, UnverifiedEmailError, authorizeUrl } from "./google";

export const GOOGLE_STATE_COOKIE = "ps_google_state";
export const GOOGLE_VERIFIER_COOKIE = "ps_google_verifier";

/** What the Google sign-in routes need from the server, passed in so a test can stand in for it. */
export type GoogleStartDeps = {
  limiter: RateLimiter | undefined;
  /** Null while the deployment has no Google client. */
  config: () => GoogleConfig | null;
  setCookie: (name: string, value: string, options: CookieOptions) => void;
};

export type GoogleCallbackDeps = {
  limiter: RateLimiter | undefined;
  config: () => GoogleConfig | null;
  getCookie: (name: string) => string | undefined;
  deleteCookie: (name: string, options: { path: string }) => void;
  fetchProfile: (
    config: GoogleConfig,
    code: string,
    verifier: string,
    callback: string,
  ) => Promise<GoogleProfile>;
  /** Saves the profile and answers the user's id. */
  signInUser: (profile: GoogleProfile) => Promise<string>;
  startSession: (userId: string) => Promise<void>;
};

/** `/auth/google`: a 404 while the deployment has no Google client. */
export async function googleStart(request: Request, deps: GoogleStartDeps): Promise<Response> {
  const config = deps.config();
  if (!config) return new Response("Not found", { status: 404 });
  if (await overLimit(deps.limiter, ipKey(request))) return signInLimited();
  const url = new URL(request.url);
  const state = randomToken("");
  const verifier = randomToken("");
  const cookie = {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: "/auth/google",
    maxAge: 600,
  } as const;
  deps.setCookie(GOOGLE_STATE_COOKIE, state, cookie);
  deps.setCookie(GOOGLE_VERIFIER_COOKIE, verifier, cookie);
  const callback = new URL("/auth/google/callback", url).toString();
  const location = await authorizeUrl(config, state, verifier, callback);
  return new Response(null, { status: 302, headers: { location } });
}

/** Trade the code for the account and start its session; a refusal is a page that says why. */
async function signIn(
  deps: GoogleCallbackDeps,
  config: GoogleConfig,
  grant: { code: string; verifier: string; callback: string },
) {
  try {
    const profile = await deps.fetchProfile(config, grant.code, grant.verifier, grant.callback);
    await deps.startSession(await deps.signInUser(profile));
  } catch (error) {
    if (error instanceof UnverifiedEmailError)
      return new Response(`${error.message} Verify it with Google, then try again.`, {
        status: 400,
      });
    if (error instanceof EmailInUseError)
      return new Response(`${error.message} Sign in with GitHub instead.`, { status: 409 });
    throw error;
  }
  return new Response(null, { status: 302, headers: { location: "/orgs" } });
}

/** `/auth/google/callback`: `state` and the PKCE verifier must come back from their cookies. */
export async function googleCallback(
  request: Request,
  deps: GoogleCallbackDeps,
): Promise<Response> {
  const config = deps.config();
  if (!config) return new Response("Not found", { status: 404 });
  if (await overLimit(deps.limiter, ipKey(request))) return signInLimited();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = deps.getCookie(GOOGLE_STATE_COOKIE);
  const verifier = deps.getCookie(GOOGLE_VERIFIER_COOKIE);
  deps.deleteCookie(GOOGLE_STATE_COOKIE, { path: "/auth/google" });
  deps.deleteCookie(GOOGLE_VERIFIER_COOKIE, { path: "/auth/google" });
  // Turned down at Google's consent screen: back to the sign-in page, nothing to report.
  if (url.searchParams.get("error"))
    return new Response(null, { status: 302, headers: { location: "/" } });
  if (!code || !state || !verifier || url.searchParams.get("state") !== state)
    return new Response("Sign-in expired or was tampered with. Try again.", { status: 400 });
  return signIn(deps, config, { code, verifier, callback: new URL(url.pathname, url).toString() });
}
