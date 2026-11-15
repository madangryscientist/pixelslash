import handler from "@tanstack/react-start/server-entry";
import { REDIRECTS } from "#/content/moved";

/**
 * The site Worker's entry: the four marketing pages moved to slashslash.build, so their old paths
 * answer a 301 there. No asset matches them any more, so every such request reaches this code.
 * Everything else is TanStack Start's.
 */
export default {
  fetch(request: Request): Response | Promise<Response> {
    const target = REDIRECTS.get(new URL(request.url).pathname);
    if (target !== undefined) return Response.redirect(target, 301);
    return handler.fetch(request);
  },
};
