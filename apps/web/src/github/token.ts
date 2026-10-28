import { GithubError, type GithubApp, type GithubAppDeps } from "./app";

/*
 * The GitHub token transport (PS-235), outbound only: a self-host without the App posts the
 * build verdict as a commit status with a fine-grained token (commit statuses: write). The token
 * is the deployment's secret and acts on every repo it can reach, so unlike the App there is no
 * per-repo minting. The client has the App client's shape, so the check-run code takes either.
 */

/** The deployment's token and the API base (a stub in tests). */
export type GithubTokenConfig = { token: string; apiBase: string };

/** The Worker's token secret: `GITHUB_STATUS_TOKEN` via `wrangler secret put` or `.dev.vars`. */
export type GithubTokenEnv = { GITHUB_STATUS_TOKEN?: string; GITHUB_API_BASE?: string };

/** The token's config, or null when it is unset or blank: then nothing calls GitHub with it. */
export function githubTokenConfigOf(env: GithubTokenEnv): GithubTokenConfig | null {
  const token = env.GITHUB_STATUS_TOKEN?.trim();
  if (!token) return null;
  return { token, apiBase: env.GITHUB_API_BASE?.trim() || "https://api.github.com" };
}

/** One GitHub call waits this long, then is aborted: a slow GitHub never holds a review up. */
const GITHUB_TIMEOUT_MS = 5000;

/** The token's client: every call carries the token, so the repo only names the call's target. */
export function createGithubToken(config: GithubTokenConfig, deps: GithubAppDeps = {}): GithubApp {
  const send = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? GITHUB_TIMEOUT_MS;
  return {
    async request(_repo, method, path, body) {
      const res = await send(new URL(path, config.apiBase).href, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${config.token}`,
          "user-agent": "pixelslash",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new GithubError(method, path, res.status, await res.text());
      return res.status === 204 ? null : res.json();
    },
  };
}
