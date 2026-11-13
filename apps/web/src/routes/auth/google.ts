import { createFileRoute } from "@tanstack/react-router";
import { setCookie } from "@tanstack/react-start/server";
import { googleStart } from "#/auth/sign-in-google";
import { googleConfig, signInRateLimit } from "#/server/env";

/** Sign in with Google (PS-274): a 404 while the deployment has no Google client. */
export const Route = createFileRoute("/auth/google")({
  server: {
    handlers: {
      GET: ({ request }) =>
        googleStart(request, { limiter: signInRateLimit(), config: googleConfig, setCookie }),
    },
  },
});
