import { createFileRoute } from "@tanstack/react-router";
import { HowItWorksPage } from "#/components/pages/how-it-works";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/how-it-works")({
  head: () => pageHead("/how-it-works"),
  component: HowItWorksPage,
});
