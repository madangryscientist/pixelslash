import { createFileRoute } from "@tanstack/react-router";
import { PricingPage } from "#/components/pages/pricing";

export const Route = createFileRoute("/pricing")({
  head: () => ({ meta: [{ title: "Pricing · PixelSlash" }] }),
  component: PricingPage,
});
