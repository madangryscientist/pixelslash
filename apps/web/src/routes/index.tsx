import { createFileRoute, redirect } from "@tanstack/react-router";
import { ButtonLink, CenteredLayout } from "@hackcove/ui";
import { Page } from "#/components/ui";
import { getViewer } from "#/server/fns";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await getViewer()) throw redirect({ to: "/orgs" });
  },
  component: SignIn,
});

function SignIn() {
  return (
    <Page>
      <CenteredLayout title="PixelSlash" subtitle="Visual review for every build.">
        <ButtonLink href="/auth/github">Sign in with GitHub</ButtonLink>
      </CenteredLayout>
    </Page>
  );
}
