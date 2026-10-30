/**
 * The theme is a class on <html>. An explicit choice lives in a cookie, so the server renders it
 * and a hard reload never flashes the other theme; with no cookie the page follows the system's
 * `prefers-color-scheme`, decided by `THEME_SCRIPT` before first paint.
 */
export type Theme = "light" | "dark";

export const THEME_COOKIE = "ps_theme";

const ONE_YEAR = 60 * 60 * 24 * 365;

export function parseTheme(value: string | undefined | null): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/**
 * Runs in <head>, before the body paints. It must be tiny and unable to throw: a throw would
 * leave the page in the wrong theme. The server already put the class on <html> for a visitor with
 * a cookie; this covers the visitor without one.
 */
export const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)/);var d=m?m[1]==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

/** An explicit choice, remembered for the server's next render. The toggle flips the class itself. */
export function rememberTheme(theme: Theme): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`;
}
