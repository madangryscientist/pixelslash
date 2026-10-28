import { createFileRoute } from "@tanstack/react-router";
import { SecurityPage } from "#/components/pages/security";

export const Route = createFileRoute("/security")({
  head: () => ({ meta: [{ title: "Security · PixelSlash" }] }),
  component: SecurityPage,
});
