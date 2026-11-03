import { createFileRoute } from "@tanstack/react-router";
import { DocsIndexPage, OLD_ANCHOR_SCRIPT } from "#/components/pages/docs";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [{ title: "Docs · PixelSlash" }],
    // `/docs#anchor` links from before the split land on the page that holds the anchor.
    scripts: [{ children: OLD_ANCHOR_SCRIPT }],
  }),
  component: DocsIndexPage,
});
