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

/** The theme the page shows right now: the class on <html> is the source of truth. */
export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Subscribes to the class on <html> changing, whoever changes it. */
export function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** An explicit choice: flip the class now and remember it for the server's next render. */
export function chooseTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`;
}
