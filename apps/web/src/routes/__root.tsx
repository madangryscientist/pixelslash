import { appShellRootClass } from "@hackcove/ui";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { THEME_SCRIPT } from "#/lib/theme";
import { getShell } from "#/server/fns";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  // The viewer for the header and the theme cookie for the <html> class, both from the server.
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
  const { theme } = Route.useLoaderData();
  return (
    // The class legitimately differs from the server's markup when the script resolved the system theme.
    <html
      lang="en"
      className={theme === "dark" ? `dark ${appShellRootClass}` : appShellRootClass}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
