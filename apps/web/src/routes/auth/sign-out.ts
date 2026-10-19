import { createFileRoute } from "@tanstack/react-router";
import { stopSession } from "#/server/session";

export const Route = createFileRoute("/auth/sign-out")({
  server: {
    handlers: {
      POST: async () => {
        await stopSession();
        return new Response(null, { status: 303, headers: { location: "/" } });
      },
    },
  },
});
