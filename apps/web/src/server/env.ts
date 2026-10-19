import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { GithubConfig } from "#/auth/github";
import type { Db } from "#/db/db";

/** The one place that touches the Worker's bindings; everything below takes plain values. */
export const database = (): Db => drizzle(env.DB);

export function githubConfig(): GithubConfig {
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!env.GITHUB_CLIENT_ID || !clientSecret)
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set");
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret,
    oauthBase: env.GITHUB_OAUTH_BASE,
    apiBase: env.GITHUB_API_BASE,
  };
}
