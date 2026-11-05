import manifest from "../../../web/github-app/manifest.json";
import { CLI_SPLIT } from "./cli-pages.ts";
import { DOC_PAGES } from "./docs-map.ts";

/**
 * No link may lead somewhere a visitor cannot open, so the repository and the hosted app each sit
 * behind one switch that is off until that destination opens. The repository opened on
 * 2026-11-03 (PS-257, PS-292); the hosted app has not.
 */
export const REPO_PUBLIC = true;
export const APP_LIVE = false;

/** The repository, from the same file `docs/capabilities/build.py` reads it from. */
export const REPO_URL: string = manifest.url;
export const APP_URL = "https://app.pixelslash.dev";
export const CONTACT = "hello@hack-cove.com";

/** A repo file a page renders, and the site path it is shown on. */
const SITE_PATHS: Record<string, string> = {
  "docs/cli.md": "/docs",
  ...Object.fromEntries(
    DOC_PAGES.flatMap((page) => (page.file ? [[page.file, `/docs/${page.slug}`]] : [])),
  ),
  "apps/web/SELF-HOST.md": "/self-host",
  "SECURITY.md": "/security",
  "docs/capabilities/matrix.html": "/compare",
};

type Gates = { repoPublic: boolean; appLive: boolean };

const GATES: Gates = { repoPublic: REPO_PUBLIC, appLive: APP_LIVE };

const REPO_HOSTS = [
  "github.com/madangryscientist/pixelslash",
  "ghcr.io/madangryscientist/pixelslash",
];

/** `a/b/../c` → `a/c`, against the directory of `sourcePath`. */
function joinRepoPath(sourcePath: string, relative: string): string {
  const parts = sourcePath.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

function resolveExternal(href: string, gates: Gates): string | null {
  if (REPO_HOSTS.some((host) => href.includes(host))) return gates.repoPublic ? href : null;
  if (href.startsWith(APP_URL)) return gates.appLive ? href : null;
  return href;
}

const CLI_DOC_PATH = "docs/cli.md";
const PUBLIC_DIR = "apps/site/public/";

/** Where a heading of docs/cli.md is shown: the site cuts the file into pages, so an anchor names one. */
function cliAnchorHref(anchor: string, currentPage?: string): string {
  const slug = CLI_SPLIT.anchorPage.get(anchor);
  if (slug === undefined) throw new Error(`${CLI_DOC_PATH} has no heading #${anchor} to link to`);
  return slug === currentPage ? `#${anchor}` : `/docs/${slug}#${anchor}`;
}

function resolveRepoFile(href: string, sourcePath: string, gates: Gates): string | null {
  const [path = "", anchor] = href.split("#");
  const repoPath = joinRepoPath(sourcePath, path);
  if (repoPath === CLI_DOC_PATH && anchor !== undefined) return cliAnchorHref(anchor);
  const sitePath = SITE_PATHS[repoPath];
  if (sitePath !== undefined) return anchor === undefined ? sitePath : `${sitePath}#${anchor}`;
  return gates.repoPublic ? `${REPO_URL}/blob/main/${repoPath}` : null;
}

/**
 * Where an image in a rendered repo document is served from, or `null` when it is not in the
 * site's `public` directory. The path stays relative in the file, so GitHub draws it as well.
 */
export function resolveImageSrc(href: string, sourcePath: string): string | null {
  const repoPath = joinRepoPath(sourcePath, href);
  return repoPath.startsWith(PUBLIC_DIR) ? `/${repoPath.slice(PUBLIC_DIR.length)}` : null;
}

/**
 * Where a link in a rendered repo document goes on the site, or `null` when it has nowhere a
 * visitor can follow yet (it is then drawn as plain text). `sourcePath` is the document's path in
 * the repo, so a relative link resolves as it does on GitHub. `currentPage` is the docs page a
 * `#anchor` link sits on, so a link to a heading elsewhere in docs/cli.md can leave it.
 */
export function resolveHref(
  href: string,
  sourcePath: string,
  gates: Gates = GATES,
  currentPage?: string,
): string | null {
  if (href.startsWith("#") && sourcePath === CLI_DOC_PATH) {
    return cliAnchorHref(href.slice(1), currentPage);
  }
  if (href.startsWith("#") || href.startsWith("mailto:")) return href;
  if (/^[a-z]+:\/\//.test(href)) return resolveExternal(href, gates);
  return resolveRepoFile(href, sourcePath, gates);
}
