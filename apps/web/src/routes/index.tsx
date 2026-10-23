import { createFileRoute, redirect } from "@tanstack/react-router";
import { CenteredLayout, buttonClass } from "@hackcove/ui";
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
        <a href="/auth/github" className={buttonClass()}>
          Sign in with GitHub
        </a>
      </CenteredLayout>
    </Page>
  );
}
