import { createFileRoute } from "@tanstack/react-router";
import { DocsIndexPage } from "#/components/pages/docs";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/docs/")({
  head: () => pageHead("/docs"),
  component: DocsIndexPage,
});
