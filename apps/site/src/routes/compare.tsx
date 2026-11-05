import { createFileRoute } from "@tanstack/react-router";
import { ComparePage } from "#/components/pages/compare";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/compare")({
  head: () => pageHead("/compare"),
  component: ComparePage,
});
