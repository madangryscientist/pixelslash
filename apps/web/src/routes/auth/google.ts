import { createFileRoute } from "@tanstack/react-router";
import { setCookie } from "@tanstack/react-start/server";
import { authorizeUrl } from "#/auth/google";
import { randomToken } from "#/lib/crypto";
import { googleConfig, signInRateLimit } from "#/server/env";
import { ipKey, overLimit, signInLimited } from "#/server/rate-limit";

export const GOOGLE_STATE_COOKIE = "ps_google_state";
export const GOOGLE_VERIFIER_COOKIE = "ps_google_verifier";

/** Sign in with Google (PS-274): a 404 while the deployment has no Google client. */
export const Route = createFileRoute("/auth/google")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const config = googleConfig();
        if (!config) return new Response("Not found", { status: 404 });
        if (await overLimit(signInRateLimit(), ipKey(request))) return signInLimited();
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
        setCookie(GOOGLE_STATE_COOKIE, state, cookie);
        setCookie(GOOGLE_VERIFIER_COOKIE, verifier, cookie);
        const callback = new URL("/auth/google/callback", url).toString();
        const location = await authorizeUrl(config, state, verifier, callback);
        return new Response(null, { status: 302, headers: { location } });
      },
    },
  },
});
