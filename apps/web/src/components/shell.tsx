import { Link, getRouteApi } from "@tanstack/react-router";
import { AppShellBrand, ColourSchemeToggle } from "@hackcove/ui";
import { rememberTheme } from "#/lib/theme";
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

/** The mark and wordmark as one link home: the app for someone signed in, the landing page otherwise. */
export function AppBrand() {
  const { viewer } = rootRoute.useLoaderData();
  return (
    <AppShellBrand
      logo={<Logo />}
      label="PixelSlash"
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
