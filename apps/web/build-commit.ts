import { execFileSync } from "node:child_process";

/**
 * The commit a build is made from, for the page's `build-commit` meta: after a deploy,
 * `scripts/check-commit.ts` reads it back to prove which commit is live. `BUILD_COMMIT` wins when set
 * and not empty (a Docker build has no `.git`); else the checkout's HEAD, with `-dirty` when the tree
 * has changes; else `unknown`, so a build with neither still builds. Imported by both apps'
 * `vite.config.ts`; it lives in `apps/web` because the self-host image copies only that app.
 */
export function buildCommit(
  options: { env?: Record<string, string | undefined>; cwd?: string } = {},
): string {
  const fromEnv = (options.env ?? process.env)["BUILD_COMMIT"]?.trim();
  if (fromEnv) return fromEnv;
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const sha = git("rev-parse", "HEAD");
    return git("status", "--porcelain") === "" ? sha : `${sha}-dirty`;
  } catch {
    return "unknown";
  }
}
