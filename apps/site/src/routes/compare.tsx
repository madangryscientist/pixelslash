import { createFileRoute } from "@tanstack/react-router";
import { ComparePage } from "#/components/pages/compare";

export const Route = createFileRoute("/compare")({
  head: () => ({ meta: [{ title: "How we compare · PixelSlash" }] }),
  component: ComparePage,
});
