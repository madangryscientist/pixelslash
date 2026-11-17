import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie, getCookie } from "@tanstack/react-start/server";
import { fetchGoogleProfile } from "#/auth/google";
import { googleCallback } from "#/auth/sign-in-google";
import { signInGoogleUser } from "#/db/users";
import { database, googleConfig, signInRateLimit } from "#/server/env";
import { startSession } from "#/server/session";

export const Route = createFileRoute("/auth/google/callback")({
  server: {
    handlers: {
      GET: ({ request }) =>
        googleCallback(request, {
          limiter: signInRateLimit(),
          config: googleConfig,
          getCookie,
          deleteCookie,
          fetchProfile: fetchGoogleProfile,
          signInUser: async (profile) => (await signInGoogleUser(database(), profile)).id,
          startSession,
        }),
    },
  },
});
