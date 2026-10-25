import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { GithubConfig } from "#/auth/github";
import type { Db } from "#/db/db";
import type { ExplainQueue } from "#/ai/explain-queue";
import { diffLocationOf } from "#/db/orgs";
import { wasmDiff } from "#/diff/wasm";
import type { DiffLocation } from "#/db/schema";
import { type BlobStore, r2BlobStore } from "#/storage/blobs";

/** The one place that touches the Worker's bindings; everything below takes plain values. */
export const database = (): Db => drizzle(env.DB);

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
 * The self-host's diff sidecar (PS-203): a loopback URL where a Bun process runs the diff with the
 * native codec. Cloudflare never sets it; unset, the server diff runs here in-process (WebAssembly,
 * or pngjs when `DIFF_WASM` is not `1`).
 */
export const diffSidecarUrl = (): string | undefined => env.DIFF_SIDECAR_URL || undefined;

/**
 * The in-process diff (PS-204): the WebAssembly one when `DIFF_WASM` is `1`, else undefined, which
 * is the engine's pngjs `diffPngs`. On in every config since PS-207; byte-identical either way, so
 * any other value (`""` included) is the rollback to pngjs.
 */
export const inProcessDiff = (): typeof wasmDiff | undefined =>
  env.DIFF_WASM === "1" ? wasmDiff : undefined;

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
