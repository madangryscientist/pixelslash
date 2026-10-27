import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie, getCookie } from "@tanstack/react-start/server";
import { fetchGithubProfile } from "#/auth/github";
import { signInGithubUser } from "#/db/users";
import { database, githubConfig, signInRateLimit } from "#/server/env";
import { ipKey, overLimit, signInLimited } from "#/server/rate-limit";
import { startSession } from "#/server/session";
import { OAUTH_STATE_COOKIE } from "./github";

export const Route = createFileRoute("/auth/github/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (await overLimit(signInRateLimit(), ipKey(request))) return signInLimited();
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = getCookie(OAUTH_STATE_COOKIE);
        deleteCookie(OAUTH_STATE_COOKIE, { path: "/auth/github" });
        if (!code || !state || url.searchParams.get("state") !== state)
          return new Response("Sign-in expired or was tampered with. Try again.", { status: 400 });
        const callback = new URL(url.pathname, url).toString();
        const profile = await fetchGithubProfile(githubConfig(), code, callback);
        const user = await signInGithubUser(database(), profile);
        await startSession(user.id);
        return new Response(null, { status: 302, headers: { location: "/orgs" } });
      },
    },
  },
});
