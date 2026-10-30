import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie, getCookie } from "@tanstack/react-start/server";
import { type GoogleConfig, UnverifiedEmailError, fetchGoogleProfile } from "#/auth/google";
import { EmailInUseError, signInGoogleUser } from "#/db/users";
import { database, googleConfig, signInRateLimit } from "#/server/env";
import { ipKey, overLimit, signInLimited } from "#/server/rate-limit";
import { startSession } from "#/server/session";
import { GOOGLE_STATE_COOKIE, GOOGLE_VERIFIER_COOKIE } from "./google";

/** Trade the code for the account and start its session; a refusal is a page that says why. */
async function signIn(config: GoogleConfig, code: string, verifier: string, callback: string) {
  try {
    const profile = await fetchGoogleProfile(config, code, verifier, callback);
    const user = await signInGoogleUser(database(), profile);
    await startSession(user.id);
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

export const Route = createFileRoute("/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const config = googleConfig();
        if (!config) return new Response("Not found", { status: 404 });
        if (await overLimit(signInRateLimit(), ipKey(request))) return signInLimited();
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = getCookie(GOOGLE_STATE_COOKIE);
        const verifier = getCookie(GOOGLE_VERIFIER_COOKIE);
        deleteCookie(GOOGLE_STATE_COOKIE, { path: "/auth/google" });
        deleteCookie(GOOGLE_VERIFIER_COOKIE, { path: "/auth/google" });
        // Turned down at Google's consent screen: back to the sign-in page, nothing to report.
        if (url.searchParams.get("error"))
          return new Response(null, { status: 302, headers: { location: "/" } });
        if (!code || !state || !verifier || url.searchParams.get("state") !== state)
          return new Response("Sign-in expired or was tampered with. Try again.", { status: 400 });
        return signIn(config, code, verifier, new URL(url.pathname, url).toString());
      },
    },
  },
});
