import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";

/**
 * Server-renders `ui` inside a router, so a component with a `<Link>` renders its real `href`. The
 * router has one route (the root) and no route tree of the app, so a link's target is the string
 * the component built, not a page: that is what a render test asserts. Returns the HTML.
 */
export async function renderRouted(ui: ReactNode): Promise<string> {
  const root = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

/** The visible text of rendered HTML: tags dropped, entities for `&` and the quotes undone. */
export const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
