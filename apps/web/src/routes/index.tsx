import { createFileRoute, redirect } from "@tanstack/react-router";
import { Display, Lead, buttonClass } from "@hackcove/ui";
import { AppHeader } from "#/components/shell";
import { getViewer } from "#/server/fns";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await getViewer()) throw redirect({ to: "/orgs" });
  },
  component: SignIn,
});

function SignIn() {
  return (
    <div className="app-canvas min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-md p-8 pt-24 text-center">
        <Display className="!text-4xl">PixelSlash</Display>
        <Lead className="mt-2">Visual review for every build.</Lead>
        <a href="/auth/github" className={`${buttonClass()} mt-8 px-5 py-2.5`}>
          Sign in with GitHub
        </a>
      </main>
    </div>
  );
}
