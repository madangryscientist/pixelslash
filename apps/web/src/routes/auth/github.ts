import { createFileRoute } from "@tanstack/react-router";
import { setCookie } from "@tanstack/react-start/server";
import { authorizeUrl } from "#/auth/github";
import { randomToken } from "#/lib/crypto";
import { githubConfig } from "#/server/env";

export const OAUTH_STATE_COOKIE = "ps_oauth_state";

export const Route = createFileRoute("/auth/github")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const state = randomToken("");
        setCookie(OAUTH_STATE_COOKIE, state, {
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "lax",
          path: "/auth/github",
          maxAge: 600,
        });
        const callback = new URL("/auth/github/callback", url).toString();
        const location = authorizeUrl(githubConfig(), state, callback);
        return new Response(null, { status: 302, headers: { location } });
      },
    },
  },
});
