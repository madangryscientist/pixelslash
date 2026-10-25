import { ErrorPage, NotFound } from "@hackcove/ui";
import { createRouter as createTanStackRouter, Link } from "@tanstack/react-router";
import { Page } from "#/components/ui";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: () => (
      <Page>
        <NotFound renderHome={(props) => <Link to="/" {...props} />} />
      </Page>
    ),
    defaultErrorComponent: ({ reset }) => (
      <Page>
        <ErrorPage onRetry={reset} renderHome={(props) => <Link to="/" {...props} />} />
      </Page>
    ),
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
