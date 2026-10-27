import { importAppKey, signAppJwt } from "./jwt";

/*
 * The PixelSlash GitHub App (PS-23), outbound only: it signs its JWT, finds the repo's
 * installation, mints an installation token and calls the REST API with it. No webhooks, no
 * Octokit: `fetch` and Web Crypto, so the Worker and the LAN server run the same code.
 */

/** The deployment's App: its id, its private key (see `pemOf`) and the API base (a stub in tests). */
export type GithubAppConfig = { appId: string; privateKey: string; apiBase: string };

/** The Worker's App vars: `GITHUB_APP_ID` in `vars` or `.dev.vars`, the key as a secret. */
export type GithubAppEnv = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_API_BASE?: string;
};

/** The App's config, or null when either the id or the key is unset: then nothing calls GitHub. */
export function githubAppConfigOf(env: GithubAppEnv): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return null;
  return { appId, privateKey, apiBase: env.GITHUB_API_BASE?.trim() || "https://api.github.com" };
}

/** An installation token is minted again this long before GitHub says it expires. */
export const TOKEN_REFRESH_MS = 5 * 60_000;
/** One GitHub call waits this long, then is aborted: a slow GitHub never holds a review up. */
const GITHUB_TIMEOUT_MS = 5000;

/** A GitHub reply that was not a 2xx; the body is cut short, and never carries our token. */
export class GithubError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`GitHub ${method} ${path}: ${status} ${body.slice(0, 200)}`);
    this.name = "GithubError";
    this.status = status;
  }
}

/** A repo as `owner/name`. */
export type RepoName = `${string}/${string}`;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Whether `repo` is `owner/name` as GitHub spells a repo. */
export function isRepoName(repo: string): repo is RepoName {
  return REPO.test(repo) && !repo.endsWith("/.") && !repo.endsWith("/..");
}

/** `owner/name` as GitHub spells a repo, trimmed, or null when it is not one. */
export function repoNameOf(input: string): RepoName | null {
  const repo = input.trim();
  return isRepoName(repo) ? repo : null;
}

export type GithubApp = {
  /** Calls the REST API as the repo's installation: `path` is relative to the API base. */
  request(repo: RepoName, method: string, path: string, body?: unknown): Promise<unknown>;
};

type Cached = { token: string; expiresAt: number };

/** The one shape of `fetch` the App calls, so a test can stand in for GitHub. */
export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export type GithubAppDeps = {
  fetch?: GithubFetch;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * The App's client. Installation tokens are cached per repo until `TOKEN_REFRESH_MS` before they
 * expire, and dropped on a 401, so a revoked one is minted again on the next call.
 */
export function createGithubApp(config: GithubAppConfig, deps: GithubAppDeps = {}): GithubApp {
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const tokens = new Map<string, Cached>();
  let key: Promise<CryptoKey> | null = null;

  async function call(auth: string, method: string, path: string, body?: unknown) {
    const res = await send(new URL(path, config.apiBase).href, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "user-agent": "pixelslash",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new GithubError(method, path, res.status, await res.text());
    return res.status === 204 ? null : res.json();
  }

  async function appJwt(): Promise<string> {
    key ??= importAppKey(config.privateKey);
    // A key that failed to import is tried again next time rather than cached as a rejection.
    const signing = await key.catch((error: unknown) => {
      key = null;
      throw error;
    });
    return signAppJwt(config.appId, signing, Math.floor(now() / 1000));
  }

  async function installationToken(repo: RepoName): Promise<string> {
    const cacheKey = repo.toLowerCase();
    const held = tokens.get(cacheKey);
    if (held && held.expiresAt - TOKEN_REFRESH_MS > now()) return held.token;
    const jwt = await appJwt();
    const installation = await call(jwt, "GET", `/repos/${repo}/installation`);
    const id = field(installation, "id");
    const name = repo.split("/")[1];
    const minted = await call(jwt, "POST", `/app/installations/${id}/access_tokens`, {
      repositories: [name],
    });
    const token = String(field(minted, "token"));
    const expiresAt = Date.parse(String(field(minted, "expires_at")));
    tokens.set(cacheKey, { token, expiresAt: Number.isNaN(expiresAt) ? now() : expiresAt });
    return token;
  }

  return {
    async request(repo, method, path, body) {
      const token = await installationToken(repo);
      try {
        return await call(token, method, path, body);
      } catch (error) {
        if (error instanceof GithubError && error.status === 401) tokens.delete(repo.toLowerCase());
        throw error;
      }
    },
  };
}

/** A field GitHub's reply must have; a reply without it is GitHub's error, named. */
export function field(reply: unknown, name: string): string | number {
  const value = typeof reply === "object" && reply !== null ? Reflect.get(reply, name) : undefined;
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`GitHub's reply has no ${name}`);
  return value;
}
