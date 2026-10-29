import { createFileRoute } from "@tanstack/react-router";
import { DocsPage } from "#/components/pages/docs";

export const Route = createFileRoute("/docs")({
  head: () => ({ meta: [{ title: "Docs · PixelSlash" }] }),
  component: DocsPage,
});
