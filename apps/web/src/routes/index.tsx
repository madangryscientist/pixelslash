import { createFileRoute, redirect } from "@tanstack/react-router";
import { getViewer } from "#/server/fns";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (await getViewer()) throw redirect({ to: "/orgs" });
  },
  component: SignIn,
});

function SignIn() {
  return (
    <main className="mx-auto max-w-md p-8 pt-24 text-center">
      <h1 className="text-3xl font-bold">PixelSlash</h1>
      <p className="mt-2 text-neutral-600">Visual review for every build.</p>
      <a
        href="/auth/github"
        className="mt-8 inline-block rounded-md bg-neutral-900 px-5 py-2.5 font-medium text-white hover:bg-neutral-700"
      >
        Sign in with GitHub
      </a>
    </main>
  );
}
