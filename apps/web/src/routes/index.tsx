import { createFileRoute, redirect } from "@tanstack/react-router";
import { Button, CenteredLayout } from "@hackcove/ui";
import { Page } from "#/components/ui";
import { getViewer } from "#/server/fns";
import { getSignInOptions } from "#/server/sign-in";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await getViewer()) throw redirect({ to: "/orgs" });
  },
  loader: () => getSignInOptions(),
  component: SignIn,
});

function SignIn() {
  const { google } = Route.useLoaderData();
  return (
    <Page>
      <CenteredLayout title="PixelSlash" subtitle="Visual review for every build.">
        <div className="flex flex-col items-stretch gap-3">
          <Button href="/auth/github">Sign in with GitHub</Button>
          {google && (
            <Button href="/auth/google" variant="outline">
              Sign in with Google
            </Button>
          )}
        </div>
      </CenteredLayout>
    </Page>
  );
}
