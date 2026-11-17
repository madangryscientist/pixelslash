import { ErrorPage, NotFound } from "@hackcove/ui-react";
import {
  createRouter as createTanStackRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { SLASHSLASH } from "./content/moved.ts";
import { routeTree } from "./routeTree.gen";

function RouteError({ reset }: ErrorComponentProps) {
  return <ErrorPage onRetry={reset} renderHome={(props) => <a href={SLASHSLASH} {...props} />} />;
}

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <NotFound renderHome={(props) => <a href={SLASHSLASH} {...props} />} />
    ),
    defaultErrorComponent: RouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
