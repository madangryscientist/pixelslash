import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "#/components/pages/home";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/")({
  head: () => pageHead("/"),
  component: HomePage,
});
