import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { GithubConfig } from "#/auth/github";
import type { Db } from "#/db/db";
import type { ExplainQueue } from "#/ai/explain-queue";
import { retryBusy } from "#/db/busy";
import { diffLocationOf } from "#/db/orgs";
import { type GithubApp, createGithubApp, githubAppConfigOf } from "#/github/app";
import { type CheckRunDeps, syncCheckRuns } from "#/github/check-run";
import type { DiffLocation } from "#/db/schema";
import { type BlobStore, r2BlobStore } from "#/storage/blobs";
import { type SentryConfig, sentryConfigOf } from "./sentry-config";

/**
 * The one place that touches the Worker's bindings; everything below takes plain values. A locked
 * database (a deploy migrating the self-host's D1) is waited out, not an error (PS-228).
 */
export const database = (): Db => drizzle(retryBusy(env.DB));

export const blobStore = (): BlobStore => r2BlobStore(env.BLOBS);

/** The queue a run's changed shots are explained from (ob 1875); its consumer is `src/server.ts`. */
export const explainQueue = (): ExplainQueue => env.EXPLAIN;

/** Signs the short-lived image URLs; a deployment sets it with `wrangler secret put`. */
export function imageSigningSecret(): string {
  const secret = env.IMAGE_SIGNING_SECRET;
  if (!secret) throw new Error("IMAGE_SIGNING_SECRET must be set to sign image URLs");
  return secret;
}

/**
 * Seals a project's model API key at rest (ob 1786); a deployment sets it with `wrangler secret put`.
 * Unset is not an error here: saving a key then fails with a named error, and reading a sealed one
 * means no model for that project (`projectModelFor`).
 */
export const modelKeySecret = (): string | undefined => env.MODEL_KEY_SECRET || undefined;

/**
 * The self-host's diff sidecar (PS-203): a loopback URL where a Bun process runs the same
 * `diff.wasm` diff outside workerd's memory. Cloudflare never sets it; unset, the server diff runs
 * here in-process, in the same module (PS-210).
 */
export const diffSidecarUrl = (): string | undefined => env.DIFF_SIDECAR_URL || undefined;

/**
 * Where this deployment reports its errors (PS-227): null without a DSN, which is the whole
 * feature switched off. The same config goes to the browser, so both report as one release.
 */
export const sentryConfig = (): SentryConfig | null => sentryConfigOf(env);

/** The oldest CLI the API takes (`x.y.z`, ob 1729); empty takes any. Set in `vars`. */
export const minCliVersion = (): string | undefined => env.MIN_CLI_VERSION || undefined;

/** Where a new project diffs (ob 1727): `DEFAULT_DIFF_LOCATION`, read by `diffLocationOf`. */
export const defaultDiffLocation = (): DiffLocation => diffLocationOf(env.DEFAULT_DIFF_LOCATION);

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

/**
 * The deployment's GitHub App (PS-23), or null without `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.
 * One client per isolate, so its installation tokens are cached across requests until they near
 * expiry.
 */
let app: GithubApp | undefined;

function githubApp(): GithubApp | null {
  const config = githubAppConfigOf(env);
  if (!config) return null;
  app ??= createGithubApp(config);
  return app;
}

/** What a build's check run is synced with: the App and the public URL its link points at. */
export const checkRunDeps = (db: Db): CheckRunDeps => ({
  db,
  app: githubApp(),
  publicUrl: env.PIXELSLASH_PUBLIC_URL || undefined,
});

/** Whether the deployment has a GitHub App, for the project settings' note. */
export const githubAppConfigured = (): boolean => githubApp() !== null;

/** Bring the builds' check runs up to their state (PS-23); never throws. */
export const syncChecks = (db: Db, buildIds: Iterable<string>): Promise<void> =>
  syncCheckRuns(checkRunDeps(db), buildIds);
