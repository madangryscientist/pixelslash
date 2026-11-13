import { createFileRoute } from "@tanstack/react-router";
import { setCookie } from "@tanstack/react-start/server";
import { githubStart } from "#/auth/sign-in-github";
import { githubConfig, signInRateLimit } from "#/server/env";

export const Route = createFileRoute("/auth/github")({
  server: {
    handlers: {
      GET: ({ request }) =>
        githubStart(request, { limiter: signInRateLimit(), config: githubConfig, setCookie }),
    },
  },
});
