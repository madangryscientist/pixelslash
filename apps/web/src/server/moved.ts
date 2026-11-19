/**
 * Where an old address on pixelslash.dev now lives, or null when the app answers it as it is.
 *
 * The review app moved from app.pixelslash.dev to the apex, pixelslash.dev, which used to serve the
 * docs site. On the old host a page view goes to the same path on the apex; the API, the sign-in
 * callbacks and the signed image URLs are still served there, because a redirect to another origin
 * drops the Authorization header (CLI and CI uploads) and a POST cannot be redirected safely. The
 * docs site's pages and files moved to slashslash.build, so their old paths go there on either
 * host. Any other host (a self-host, a local build) is never redirected.
 */

const APEX = "pixelslash.dev";
const OLD_APP = "app.pixelslash.dev";
const PAGES = "https://slashslash.build/pixelslash";

/** The old site's pages, each now under PAGES at the same path. */
const MOVED_PAGES = new Set(["/how-it-works", "/compare", "/pricing", "/security", "/self-host"]);

/** Paths the old host still serves itself: the API, sign-in and signed images. */
const KEPT_ON_OLD_HOST = ["/api/", "/auth/", "/images/"];

export function movedTo(url: URL, method: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (url.hostname !== APEX && url.hostname !== OLD_APP) return null;

  const path = url.pathname;
  const bare = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const site = siteAddress(bare);
  if (site) return site + url.search;

  if (url.hostname === OLD_APP && !KEPT_ON_OLD_HOST.some((prefix) => path.startsWith(prefix))) {
    return `https://${APEX}${path}${url.search}`;
  }
  return null;
}

/** The slashslash.build address of an old docs-site path (trailing slash already dropped). */
function siteAddress(path: string): string | null {
  if (MOVED_PAGES.has(path)) return PAGES + path;
  if (path === "/docs") return `${PAGES}/docs`;
  const slug = /^\/docs\/([^/]+)$/.exec(path)?.[1];
  if (slug) return `${PAGES}/docs/${slug}`;
  if (path === "/search-index.json") return `${PAGES}/search-index.json`;
  if (path === "/sitemap.xml") return "https://slashslash.build/sitemap.xml";
  return null;
}
