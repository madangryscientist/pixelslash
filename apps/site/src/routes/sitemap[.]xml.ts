import { createFileRoute } from "@tanstack/react-router";
import { sitemapXml } from "#/content/sitemap";

// One static file, written at prerender. robots.txt names it.
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => new Response(sitemapXml(), { headers: { "content-type": "application/xml" } }),
    },
  },
});
