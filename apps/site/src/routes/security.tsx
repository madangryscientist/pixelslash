import { createFileRoute } from "@tanstack/react-router";
import { SecurityPage } from "#/components/pages/security";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/security")({
  head: () => pageHead("/security"),
  component: SecurityPage,
});
