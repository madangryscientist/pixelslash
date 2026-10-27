/**
 * The GitHub sign-in stand-in (`e2e/github-stub.ts`) answers every sign-in with whoever it is told
 * to be, so a deployment pointed at it lets anyone in as anyone (PS-250). Only a dev server and the
 * test build (`CLOUDFLARE_ENV=e2e`, which the Playwright run and the LAN self-host serve) may point
 * at anything but GitHub; a production build that does fails at start, naming why.
 */

export type BuildKind = "dev" | "test" | "production";

/** Set by `vite.config.ts` for the build it makes; anything else, or nothing, is production. */
declare const PIXELSLASH_BUILD_KIND: string | undefined;

export function buildKind(): BuildKind {
  const kind = typeof PIXELSLASH_BUILD_KIND === "string" ? PIXELSLASH_BUILD_KIND : "";
  return kind === "dev" || kind === "test" ? kind : "production";
}

const GITHUB_OAUTH_BASE = "https://github.com";
const GITHUB_API_BASE = "https://api.github.com";

type GithubBases = { GITHUB_OAUTH_BASE?: string; GITHUB_API_BASE?: string };

/** Why this build may not start with these vars, or null when it may. */
export function githubStubRefusal(kind: BuildKind, vars: GithubBases): string | null {
  if (kind !== "production") return null;
  const oauth = (vars.GITHUB_OAUTH_BASE ?? "").replace(/\/+$/, "");
  const api = (vars.GITHUB_API_BASE ?? "").replace(/\/+$/, "");
  if (oauth === GITHUB_OAUTH_BASE && api === GITHUB_API_BASE) return null;
  return [
    `refusing to start: GITHUB_OAUTH_BASE is ${oauth || "unset"} and GITHUB_API_BASE is ${api || "unset"},`,
    `but a production build signs in only through ${GITHUB_OAUTH_BASE} and ${GITHUB_API_BASE}.`,
    "Another base is the e2e GitHub stand-in, which lets anyone sign in as anyone; it is for a dev",
    "server or the test build (CLOUDFLARE_ENV=e2e bun run build) only.",
  ].join(" ");
}
