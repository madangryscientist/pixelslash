import { createFileRoute } from "@tanstack/react-router";
import { SelfHostPage } from "#/components/pages/self-host";

export const Route = createFileRoute("/self-host")({
  head: () => ({ meta: [{ title: "Self-host · PixelSlash" }] }),
  component: SelfHostPage,
});
