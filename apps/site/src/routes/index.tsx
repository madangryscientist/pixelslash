import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "#/components/pages/home";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "PixelSlash: visual review for the web" }] }),
  component: HomePage,
});
