import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie, getCookie } from "@tanstack/react-start/server";
import { fetchGithubProfile } from "#/auth/github";
import { githubCallback } from "#/auth/sign-in-github";
import { signInGithubUser } from "#/db/users";
import { database, githubConfig, signInRateLimit } from "#/server/env";
import { startSession } from "#/server/session";

export const Route = createFileRoute("/auth/github/callback")({
  server: {
    handlers: {
      GET: ({ request }) =>
        githubCallback(request, {
          limiter: signInRateLimit(),
          config: githubConfig,
          getCookie,
          deleteCookie,
          fetchProfile: fetchGithubProfile,
          signInUser: async (profile) => (await signInGithubUser(database(), profile)).id,
          startSession,
        }),
    },
  },
});
