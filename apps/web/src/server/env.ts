import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { GithubConfig } from "#/auth/github";
import { buildKind, githubStubRefusal } from "#/auth/stub-guard";
import type { Db } from "#/db/db";
import type { ExplainQueue } from "#/ai/explain-queue";
import { type ModelFetch, guardedFetch } from "#/ai/model";
import type { ModelHostPolicy } from "#/ai/model-host";
import { retryBusy } from "#/db/busy";
import { diffLocationOf } from "#/db/orgs";
import { type GithubApp, createGithubApp, githubAppConfigOf } from "#/github/app";
import { type CheckRunDeps, syncCheckRuns } from "#/github/check-run";
import { createGithubToken, githubTokenConfigOf } from "#/github/token";
import type { DiffLocation } from "#/db/schema";
import { retentionDaysOf } from "#/lib/retention";
import { type BlobStore, type SweepBlobStore, r2BlobStore, r2SweepStore } from "#/storage/blobs";
import type { RateLimiter } from "./rate-limit";
import { type SentryConfig, sentryConfigOf } from "./sentry-config";

/**
 * The one place that touches the Worker's bindings; everything below takes plain values. A locked
 * database (a deploy migrating the self-host's D1) is waited out, not an error (PS-228).
 */
export const database = (): Db => drizzle(retryBusy(env.DB));

export const blobStore = (): BlobStore => r2BlobStore(env.BLOBS);

/** The store with the listing and bulk delete the retention sweep needs (PS-239). */
export const sweepStore = (): SweepBlobStore => r2SweepStore(env.BLOBS);

/** How many days a PR build lives (PS-239); undefined is retention off, the default. */
export const retentionDays = (): number | undefined =>
  retentionDaysOf(env.PIXELSLASH_RETENTION_DAYS);

/** Whether the scheduled sweep deletes; anything but `true` only logs what it would delete. */
export const retentionDelete = (): boolean => env.PIXELSLASH_RETENTION_DELETE === "true";

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
 * Which hosts a project's model may be on (PS-250): public ones, unless the self-host sets
 * `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS=1` to run its own model on its own network.
 */
export const modelHosts = (): ModelHostPolicy => ({
  allowPrivate: env.PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS === "1",
});

/** The transport for every model call: the host checked again, after resolving, under `modelHosts`. */
export const modelFetch = (): ModelFetch => guardedFetch(modelHosts());

/** The rate limits (PS-250): Cloudflare's bindings, undefined (no limit) where there are none. */
export const apiRateLimit = (): RateLimiter | undefined => env.API_RATE_LIMIT;
export const signInRateLimit = (): RateLimiter | undefined => env.SIGNIN_RATE_LIMIT;

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

/** Why this deployment may not start (PS-250): a production build pointed at the GitHub stand-in. */
export const startRefusal = (): string | null => githubStubRefusal(buildKind(), env);

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

/**
 * The deployment's token for commit statuses (PS-235), or null without `GITHUB_STATUS_TOKEN`.
 * Only used when there is no App.
 */
let statusToken: GithubApp | undefined;

function githubToken(): GithubApp | null {
  const config = githubTokenConfigOf(env);
  if (!config) return null;
  statusToken ??= createGithubToken(config);
  return statusToken;
}

/** What a build's check is synced with: the App, else the token, and the public URL its link points at. */
export const checkRunDeps = (db: Db): CheckRunDeps => ({
  db,
  app: githubApp(),
  token: githubToken(),
  publicUrl: env.PIXELSLASH_PUBLIC_URL || undefined,
});

/** Whether the deployment can post a build's verdict to GitHub (App or token), for the settings' note. */
export const githubChecksConfigured = (): boolean => githubApp() !== null || githubToken() !== null;

/** Bring the builds' check runs up to their state (PS-23); never throws. */
export const syncChecks = (db: Db, buildIds: Iterable<string>): Promise<void> =>
  syncCheckRuns(checkRunDeps(db), buildIds);
