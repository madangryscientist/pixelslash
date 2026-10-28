import { createFileRoute } from "@tanstack/react-router";
import { HowItWorksPage } from "#/components/pages/how-it-works";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({ meta: [{ title: "How it works · PixelSlash" }] }),
  component: HowItWorksPage,
});
