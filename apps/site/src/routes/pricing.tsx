import { createFileRoute } from "@tanstack/react-router";
import { PricingPage } from "#/components/pages/pricing";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/pricing")({
  head: () => pageHead("/pricing"),
  component: PricingPage,
});
