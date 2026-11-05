import { createFileRoute } from "@tanstack/react-router";
import { buildSearchIndex } from "#/content/search-index";

// One static file, written at prerender and served from the site's own origin. The docs search
// fetches it; nothing else reads it.
export const Route = createFileRoute("/search-index.json")({
  server: {
    handlers: {
      GET: () => Response.json(buildSearchIndex(), { headers: { "cache-control": "no-cache" } }),
    },
  },
});
