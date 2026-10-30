import { Link, getRouteApi } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShellBrand, Avatar, Button, Cluster, ColourSchemeToggle, Text } from "@hackcove/ui";
import { rememberTheme } from "#/lib/theme";
import { useHydrated } from "#/lib/use-hydrated";

const rootRoute = getRouteApi("__root__");

// The pixel art from PS-287: Hack Cove's letterforms on a 16-row grid, whole pixels only. Used verbatim: do not redraw
// it or rescale it to a non-integer pixel multiple, and keep shapeRendering="crispEdges", so the edges stay sharp at 1x and 2x.
const WORDMARK_LETTERS =
  "M1 0h7v1h-7zM11 0h1v1h-1zM16 0h1v1h-1zM24 0h1v1h-1zM29 0h7v1h-7zM39 0h1v1h-1zM1 1h8v1h-8zM11 1h2v1h-2zM16 1h2v1h-2zM23 1h2v1h-2zM28 1h8v1h-8zM38 1h2v1h-2zM1 2h3v1h-3zM7 2h3v1h-3zM11 2h3v1h-3zM16 2h3v1h-3zM22 2h3v1h-3zM27 2h3v1h-3zM33 2h3v1h-3zM37 2h3v1h-3zM1 3h3v1h-3zM7 3h3v1h-3zM11 3h3v1h-3zM16 3h3v1h-3zM22 3h3v1h-3zM27 3h3v1h-3zM33 3h2v1h-2zM37 3h3v1h-3zM1 4h3v1h-3zM7 4h3v1h-3zM11 4h3v1h-3zM17 4h3v1h-3zM21 4h3v1h-3zM27 4h3v1h-3zM33 4h1v1h-1zM37 4h3v1h-3zM1 5h3v1h-3zM7 5h3v1h-3zM11 5h3v1h-3zM17 5h3v1h-3zM21 5h3v1h-3zM27 5h3v1h-3zM37 5h3v1h-3zM1 6h3v1h-3zM7 6h3v1h-3zM11 6h3v1h-3zM18 6h5v1h-5zM27 6h3v1h-3zM37 6h3v1h-3zM0 7h9v1h-9zM11 7h3v1h-3zM19 7h3v1h-3zM27 7h8v1h-8zM37 7h3v1h-3zM0 8h8v1h-8zM11 8h3v1h-3zM19 8h3v1h-3zM27 8h7v1h-7zM37 8h3v1h-3zM1 9h3v1h-3zM11 9h3v1h-3zM18 9h5v1h-5zM27 9h3v1h-3zM37 9h3v1h-3zM1 10h3v1h-3zM11 10h3v1h-3zM17 10h3v1h-3zM21 10h3v1h-3zM27 10h3v1h-3zM33 10h1v1h-1zM37 10h3v1h-3zM43 10h1v1h-1zM1 11h3v1h-3zM11 11h3v1h-3zM17 11h3v1h-3zM21 11h3v1h-3zM27 11h3v1h-3zM33 11h2v1h-2zM37 11h3v1h-3zM43 11h2v1h-2zM1 12h3v1h-3zM11 12h3v1h-3zM16 12h3v1h-3zM22 12h3v1h-3zM27 12h3v1h-3zM33 12h3v1h-3zM37 12h3v1h-3zM43 12h3v1h-3zM1 13h3v1h-3zM11 13h3v1h-3zM16 13h3v1h-3zM22 13h3v1h-3zM27 13h3v1h-3zM33 13h3v1h-3zM37 13h3v1h-3zM43 13h3v1h-3zM1 14h3v1h-3zM11 14h2v1h-2zM16 14h2v1h-2zM23 14h2v1h-2zM27 14h8v1h-8zM37 14h8v1h-8zM1 15h3v1h-3zM11 15h1v1h-1zM16 15h1v1h-1zM24 15h1v1h-1zM27 15h7v1h-7zM37 15h7v1h-7zM59 0h7v1h-7zM69 0h1v1h-1zM80 0h6v1h-6zM89 0h7v1h-7zM100 0h1v1h-1zM104 0h1v1h-1zM58 1h8v1h-8zM68 1h2v1h-2zM79 1h7v1h-7zM88 1h8v1h-8zM99 1h2v1h-2zM104 1h2v1h-2zM57 2h3v1h-3zM63 2h3v1h-3zM67 2h3v1h-3zM78 2h3v1h-3zM84 2h2v1h-2zM87 2h3v1h-3zM93 2h3v1h-3zM98 2h3v1h-3zM104 2h3v1h-3zM57 3h3v1h-3zM63 3h2v1h-2zM67 3h3v1h-3zM78 3h3v1h-3zM84 3h2v1h-2zM87 3h3v1h-3zM93 3h2v1h-2zM98 3h3v1h-3zM104 3h3v1h-3zM57 4h3v1h-3zM63 4h1v1h-1zM67 4h3v1h-3zM78 4h3v1h-3zM84 4h2v1h-2zM87 4h3v1h-3zM93 4h1v1h-1zM98 4h3v1h-3zM104 4h3v1h-3zM57 5h3v1h-3zM67 5h3v1h-3zM78 5h3v1h-3zM84 5h2v1h-2zM87 5h3v1h-3zM98 5h3v1h-3zM104 5h3v1h-3zM57 6h3v1h-3zM67 6h3v1h-3zM78 6h3v1h-3zM84 6h2v1h-2zM87 6h3v1h-3zM98 6h3v1h-3zM104 6h3v1h-3zM57 7h8v1h-8zM67 7h3v1h-3zM77 7h9v1h-9zM87 7h8v1h-8zM97 7h11v1h-11zM58 8h8v1h-8zM67 8h3v1h-3zM77 8h9v1h-9zM88 8h8v1h-8zM97 8h10v1h-10zM63 9h3v1h-3zM67 9h3v1h-3zM78 9h3v1h-3zM84 9h2v1h-2zM93 9h3v1h-3zM98 9h3v1h-3zM104 9h3v1h-3zM63 10h3v1h-3zM67 10h3v1h-3zM73 10h1v1h-1zM78 10h3v1h-3zM84 10h2v1h-2zM93 10h3v1h-3zM98 10h3v1h-3zM104 10h3v1h-3zM59 11h1v1h-1zM63 11h3v1h-3zM67 11h3v1h-3zM73 11h2v1h-2zM78 11h3v1h-3zM84 11h2v1h-2zM89 11h1v1h-1zM93 11h3v1h-3zM98 11h3v1h-3zM104 11h3v1h-3zM58 12h2v1h-2zM63 12h3v1h-3zM67 12h3v1h-3zM73 12h3v1h-3zM78 12h3v1h-3zM84 12h2v1h-2zM88 12h2v1h-2zM93 12h3v1h-3zM98 12h3v1h-3zM104 12h3v1h-3zM57 13h3v1h-3zM63 13h3v1h-3zM67 13h3v1h-3zM73 13h3v1h-3zM78 13h3v1h-3zM84 13h2v1h-2zM87 13h3v1h-3zM93 13h3v1h-3zM98 13h3v1h-3zM104 13h3v1h-3zM57 14h8v1h-8zM67 14h8v1h-8zM78 14h3v1h-3zM84 14h2v1h-2zM87 14h8v1h-8zM98 14h3v1h-3zM104 14h2v1h-2zM57 15h7v1h-7zM67 15h7v1h-7zM78 15h3v1h-3zM84 15h1v1h-1zM87 15h7v1h-7zM98 15h3v1h-3zM104 15h1v1h-1z";
const WORDMARK_SLASH =
  "M54 0h2v1h-2zM54 1h2v1h-2zM53 2h3v1h-3zM53 3h3v1h-3zM52 4h3v1h-3zM52 5h3v1h-3zM51 6h3v1h-3zM51 7h3v1h-3zM50 8h3v1h-3zM50 9h3v1h-3zM49 10h3v1h-3zM49 11h3v1h-3zM48 12h3v1h-3zM48 13h3v1h-3zM47 14h3v1h-3zM47 15h3v1h-3z";
const SQUARE_LETTERS =
  "M1 0h7v1h-7zM23 0h7v1h-7zM1 1h8v1h-8zM22 1h8v1h-8zM1 2h3v1h-3zM7 2h3v1h-3zM21 2h3v1h-3zM27 2h3v1h-3zM1 3h3v1h-3zM7 3h3v1h-3zM21 3h3v1h-3zM27 3h2v1h-2zM1 4h3v1h-3zM7 4h3v1h-3zM21 4h3v1h-3zM27 4h1v1h-1zM1 5h3v1h-3zM7 5h3v1h-3zM21 5h3v1h-3zM1 6h3v1h-3zM7 6h3v1h-3zM21 6h3v1h-3zM0 7h9v1h-9zM21 7h8v1h-8zM0 8h8v1h-8zM22 8h8v1h-8zM1 9h3v1h-3zM27 9h3v1h-3zM1 10h3v1h-3zM27 10h3v1h-3zM1 11h3v1h-3zM23 11h1v1h-1zM27 11h3v1h-3zM1 12h3v1h-3zM22 12h2v1h-2zM27 12h3v1h-3zM1 13h3v1h-3zM21 13h3v1h-3zM27 13h3v1h-3zM1 14h3v1h-3zM21 14h8v1h-8zM1 15h3v1h-3zM21 15h7v1h-7z";
const SQUARE_SLASH =
  "M18 0h2v1h-2zM18 1h2v1h-2zM17 2h3v1h-3zM17 3h3v1h-3zM16 4h3v1h-3zM16 5h3v1h-3zM15 6h3v1h-3zM15 7h3v1h-3zM14 8h3v1h-3zM14 9h3v1h-3zM13 10h3v1h-3zM13 11h3v1h-3zM12 12h3v1h-3zM12 13h3v1h-3zM11 14h3v1h-3zM11 15h3v1h-3z";

/** The square mark: P/S in mauve with a blue slash on a dark tile (also public/favicon.svg). */
export function Logo({ size = 24 }: { size?: number }): ReactNode {
  return (
    <svg
      viewBox="-3 -8 36 36"
      width={size}
      height={size}
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <rect x="-3" y="-8" width="36" height="36" rx="5" fill="#181825" />
      <path fill="#cba6f7" d={SQUARE_LETTERS} />
      <path fill="#89b4fa" d={SQUARE_SLASH} />
    </svg>
  );
}

/**
 * The wordmark: PIXEL / SLASH, sized by height. The 108:16 art sets the width, so keep height a whole multiple of 16
 * (16 is one CSS pixel per art pixel). It is named "PixelSlash" for assistive tech.
 */
export function Wordmark({ height = 16 }: { height?: number }): ReactNode {
  return (
    <svg
      viewBox="0 0 108 16"
      width={(height * 108) / 16}
      height={height}
      role="img"
      aria-label="PixelSlash"
      shapeRendering="crispEdges"
    >
      <path fill="#cba6f7" d={WORDMARK_LETTERS} />
      <path fill="#89b4fa" d={WORDMARK_SLASH} />
    </svg>
  );
}

/** The theme cookie is the choice; the server's theme is what the first render shows. */
function ThemeToggle() {
  const { theme } = rootRoute.useLoaderData();
  const hydrated = useHydrated();
  return (
    <ColourSchemeToggle
      store={false}
      initial={theme === "dark" ? "dark" : "light"}
      onChange={rememberTheme}
      disabled={!hydrated}
      data-testid="theme-toggle"
    />
  );
}

/** The signed-in user and Sign out. A POST, so it works before hydration too. */
function UserMenu({ viewer }: { viewer: { login: string; name: string | null } }) {
  return (
    <Cluster gap="md">
      <span
        data-testid="viewer"
        title={viewer.name ?? viewer.login}
        className="hidden items-center gap-2 sm:flex"
      >
        <Avatar name={viewer.login} size="sm" />
        <Text>{viewer.login}</Text>
      </span>
      <Button variant="link" render={(props) => <Link to="/settings" {...props} />}>
        Settings
      </Button>
      <form method="post" action="/auth/sign-out">
        <Button type="submit" variant="link">
          Sign out
        </Button>
      </form>
    </Cluster>
  );
}

/** The mark and wordmark as one link home: the app for someone signed in, the landing page otherwise. */
export function AppBrand() {
  const { viewer } = rootRoute.useLoaderData();
  return (
    <AppShellBrand
      label={<Wordmark />}
      render={(props) => <Link to={viewer ? "/orgs" : "/"} {...props} />}
    />
  );
}

/** The end of the AppShell header: the theme toggle and, when someone is signed in, who they are and Sign out. */
export function AppControls() {
  const { viewer } = rootRoute.useLoaderData();
  return (
    <>
      <ThemeToggle />
      {viewer && <UserMenu viewer={viewer} />}
    </>
  );
}
