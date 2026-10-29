import manifest from "../../../web/github-app/manifest.json";

/**
 * The site goes public before the repository does (PS-257), and before the hosted app exists. No
 * link may lead somewhere a visitor cannot open, so each of those destinations sits behind one
 * switch that is off until it opens.
 */
export const REPO_PUBLIC = false;
export const APP_LIVE = false;

/** The repository, from the same file `docs/capabilities/build.py` reads it from. */
export const REPO_URL: string = manifest.url;
export const APP_URL = "https://app.pixelslash.dev";
export const CONTACT = "hello@hack-cove.com";

/** A repo file a page renders, and the site path it is shown on. */
const SITE_PATHS: Record<string, string> = {
  "docs/cli.md": "/docs",
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

function resolveRepoFile(href: string, sourcePath: string, gates: Gates): string | null {
  const [path = "", anchor] = href.split("#");
  const repoPath = joinRepoPath(sourcePath, path);
  const sitePath = SITE_PATHS[repoPath];
  if (sitePath !== undefined) return anchor === undefined ? sitePath : `${sitePath}#${anchor}`;
  return gates.repoPublic ? `${REPO_URL}/blob/main/${repoPath}` : null;
}

/**
 * Where a link in a rendered repo document goes on the site, or `null` when it has nowhere a
 * visitor can follow yet (it is then drawn as plain text). `sourcePath` is the document's path in
 * the repo, so a relative link resolves as it does on GitHub.
 */
export function resolveHref(href: string, sourcePath: string, gates: Gates = GATES): string | null {
  if (href.startsWith("#") || href.startsWith("mailto:")) return href;
  if (/^[a-z]+:\/\//.test(href)) return resolveExternal(href, gates);
  return resolveRepoFile(href, sourcePath, gates);
}
