import { appShellRootClassFor } from "@hackcove/ui";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { startBrowserSentry } from "#/lib/sentry-browser";
import { THEME_SCRIPT } from "#/lib/theme";
import { getShell } from "#/server/fns";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  // The viewer for the header, the theme cookie for the <html> class and the browser's error sink (PS-227), all from the server.
  loader: () => getShell(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    // Before first paint: settles the class for a visitor with no cookie (system preference).
    scripts: [{ children: THEME_SCRIPT }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  const { theme, sentry } = Route.useLoaderData();
  // After hydration, and only with a DSN: the reporter is a chunk a deployment without one never loads.
  useEffect(() => startBrowserSentry(sentry), [sentry]);
  return (
    // The class legitimately differs from the server's markup when the script resolved the system theme.
    <html
      lang="en"
      className={appShellRootClassFor(theme === "dark" ? "dark" : "light")}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
