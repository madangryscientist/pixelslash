import { Link, getRouteApi } from "@tanstack/react-router";
import { IconButton } from "@hackcove/ui";
import { useSyncExternalStore } from "react";
import { chooseTheme, currentTheme, subscribeToTheme } from "#/lib/theme";
import { useHydrated } from "#/lib/use-hydrated";

const rootRoute = getRouteApi("__root__");

/** The mark: a slash through a pixel. Gradient and cut colours are fixed, so it reads in both themes. */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id="ps-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cba6f7" />
          <stop offset="1" stopColor="#89b4fa" />
        </linearGradient>
      </defs>
      <rect width="20" height="20" rx="5" fill="url(#ps-logo)" />
      <path d="M4.5 13.5 15.5 6.5" stroke="#11111b" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** Both icons are in the markup; CSS shows the one for the theme on <html>, so no frame is wrong. */
function ThemeToggle() {
  const hydrated = useHydrated();
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme, () => "light");
  const icon = "h-4 w-4 fill-none stroke-current stroke-2";
  return (
    <IconButton
      label="Dark theme"
      aria-pressed={theme === "dark"}
      data-testid="theme-toggle"
      disabled={!hydrated}
      onClick={() => chooseTheme(theme === "dark" ? "light" : "dark")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className={`${icon} dark:hidden`}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
      </svg>
      <svg viewBox="0 0 24 24" aria-hidden="true" className={`${icon} hidden dark:block`}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </IconButton>
  );
}

/** The signed-in user and Sign out. A POST, so it works before hydration too. */
function UserMenu({ viewer }: { viewer: { login: string; name: string | null } }) {
  return (
    <div className="flex items-center gap-3">
      <span
        data-testid="viewer"
        title={viewer.name ?? viewer.login}
        className="hidden items-center gap-2 text-sm text-slate-600 sm:flex"
      >
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-xs font-medium text-slate-600"
        >
          {viewer.login.slice(0, 2).toUpperCase()}
        </span>
        {viewer.login}
      </span>
      <Link
        to="/settings"
        className="rounded text-sm text-slate-600 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
      >
        Settings
      </Link>
      <form method="post" action="/auth/sign-out">
        <button
          type="submit"
          className="rounded text-sm text-slate-600 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

/**
 * The bar on every page, one row in the AppShell header: the mark and wordmark, the theme toggle
 * and, when someone is signed in, who they are and Sign out. The viewer comes from the root loader.
 */
export function AppHeader() {
  const { viewer } = rootRoute.useLoaderData();
  return (
    <>
      <Link to={viewer ? "/orgs" : "/"} className="flex items-center gap-2 font-semibold">
        <Logo />
        PixelSlash
      </Link>
      <span className="ml-auto" />
      <ThemeToggle />
      {viewer && <UserMenu viewer={viewer} />}
    </>
  );
}
