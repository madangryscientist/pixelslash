import { ErrorPage, NotFound } from "@hackcove/ui";
import {
  createRouter as createTanStackRouter,
  type ErrorComponentProps,
  Link,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { Page } from "#/components/ui";
import { reportBrowserError } from "#/lib/sentry-browser";
import { routeTree } from "./routeTree.gen";

/** The page a route's error lands on: also reported to Sentry, when this deployment has a DSN (PS-227). */
function RouteError({ error, reset }: ErrorComponentProps) {
  useEffect(() => reportBrowserError(error), [error]);
  return (
    <Page>
      <ErrorPage onRetry={reset} renderHome={(props) => <Link to="/" {...props} />} />
    </Page>
  );
}

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
    defaultErrorComponent: RouteError,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
