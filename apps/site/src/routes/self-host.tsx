import { createFileRoute } from "@tanstack/react-router";
import { SelfHostPage } from "#/components/pages/self-host";
import { pageHead } from "#/content/seo";

export const Route = createFileRoute("/self-host")({
  head: () => pageHead("/self-host"),
  component: SelfHostPage,
});
