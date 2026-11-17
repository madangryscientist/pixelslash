import { appShellRootClassFor, colourSchemeScript } from "@hackcove/ui-react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SCHEMES, Shell } from "#/components/shell";
import appCss from "../styles.css?url";

// Set by vite.config.ts (`define`); a test run without it says unknown.
declare const PIXELSLASH_BUILD_COMMIT: string | undefined;
const BUILD_COMMIT =
  typeof PIXELSLASH_BUILD_COMMIT === "string" ? PIXELSLASH_BUILD_COMMIT : "unknown";

// colourSchemeScript knows the `dark` class only. The page is prerendered with `latte` on <html>, so
// once that script has decided, this takes `latte` off a dark page: exactly one scope is ever set.
const SCOPE_SCRIPT = `${colourSchemeScript};(function(){var r=document.documentElement;r.classList.toggle("${SCHEMES.light}",!r.classList.contains("${SCHEMES.dark}"))})()`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      // Which commit is live, read back after a deploy by scripts/check-commit.ts. Not rendered.
      { name: "build-commit", content: BUILD_COMMIT },
      { title: "PixelSlash: visual review for the web" },
      {
        name: "description",
        content:
          "PixelSlash diffs two versions of a page and shows what changed. Source available under the Elastic License 2.0, self-hostable.",
      },
    ],
    links: [
      // The one font file, fetched with the HTML rather than after the CSS (PS-307). A font preload
      // is always crossorigin, even from the same origin.
      {
        rel: "preload",
        href: "/fonts/inter-latin-wght-normal.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
    // Before first paint: the visitor's stored choice (the header's toggle), else the system's light or
    // dark, so a dark page shows no light flash. No cookie.
    scripts: [{ children: SCOPE_SCRIPT }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Shell pathname={pathname}>
      <Outlet />
    </Shell>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // The class differs from the server's markup when the script picked the dark scheme.
    <html lang="en" className={appShellRootClassFor("light", SCHEMES)} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
