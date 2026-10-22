import {
  type BaselinePick,
  type CiResult,
  type DiffLocation,
  ENGINE_VERSION,
  type PickedShot,
  isBaselinePick,
  measureShot,
} from "./ci-diff.ts";
import { DEFAULT_FLAKE_RETRIES } from "./config-flake.ts";
import { isHttpUrl } from "./routes.ts";
import { UploadError, UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import type { FlakeCheck } from "./flake.ts";
import { type FlakeOutcome, clearFlakeOutput, flakePass } from "./flake-upload.ts";
import { type GitContext, type GitOptions, gitContext } from "./git.ts";
import { identity, pngPath, readManifest } from "./manifest.ts";
import type { Shoot, SnapshotEntry } from "./snapshot.ts";
import { type Client, isObj, send, sendPng } from "./upload-client.ts";

/** The pinned capture image is Linux; the manifest carries no platform of its own. */
const PLATFORM = "linux";
const CONCURRENCY = 4;
export type UploadOptions = {
  dir: string;
  server: string;
  token: string;
  git: Omit<GitOptions, "env" | "warn">;
  /** The project to open the build in: required with a personal token, which reaches several. */
  projectId?: string | undefined;
  /**
   * How many more times a shot that differs from its baseline is captured (ob 1737); 0 turns it
   * off. Default 2. It needs `recapture`: without one nothing is captured again.
   */
  flakeRetries?: number | undefined;
};

export type UploadDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Where the git checkout and the config are looked for. Default: the process's. */
  cwd?: string;
  warn?: (message: string) => void;
  /** How a retry waits. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Capture a manifest entry again, the same way it was captured; `undefined` when the config no
   * longer has its route or variant. Without it, a changed shot is uploaded as captured.
   */
  recapture?: (e: SnapshotEntry) => Promise<Shoot | undefined>;
};

export type UploadResult = { buildId: string; snapshots: number; git: GitContext } & FlakeOutcome;

/**
 * Finalise, and again while the server's diff runs out of budget with shots left (ob 1645). The
 * server resumes: a finalise sent again measures only what is not yet measured, so this is the
 * CLI doing what a person would otherwise click. It goes on only while the count left falls, so a
 * build that is failing for another reason is tried once more and then given up, never looped.
 */
async function finalise(client: Client, id: string, count: number): Promise<unknown> {
  let left = Infinity;
  for (;;) {
    const reply = await send(client, {
      step: "finalize",
      method: "POST",
      path: `/api/v1/builds/${id}/finalize`,
      body: JSON.stringify({ snapshots: count }),
    });
    if (!isObj(reply) || reply.status !== "errored") return reply;
    const now = reply.unmeasured;
    if (typeof now !== "number" || now <= 0 || now >= left) return reply;
    client.warn(`upload: ${now} of ${count} shots still to measure on the server; continuing`);
    left = now;
  }
}

/**
 * A finalise runs the diff in the request, so its reply is the outcome. `processing` means a retry
 * met an earlier try's run that has not ended (or was killed): nothing was measured yet. `errored`
 * is said, not failed, as before: the build is on the server and the reason is the server's.
 */
function checkOutcome(client: Client, id: string, done: unknown): void {
  if (!isObj(done)) return;
  if (done.status === "processing")
    throw new UploadError(`upload failed: finalize: build ${id} is still processing on the server`);
  if (done.status === "errored")
    client.warn(`upload: build ${id} is errored on the server: ${String(done.error)}`);
}

type OpenBuild = {
  id: string;
  /** Where the project diffs; absent from a server from before ob 1727, which always diffs itself. */
  diffLocation: DiffLocation | undefined;
};

/** `clientDiff` says this CLI can measure: a project that diffs in CI refuses one that cannot. */
async function openBuild(
  client: Client,
  ctx: GitContext,
  projectId: string | undefined,
): Promise<OpenBuild> {
  const body = await send(client, {
    step: "open build",
    method: "POST",
    path: "/api/v1/builds",
    body: JSON.stringify({ ...ctx, ...(projectId ? { projectId } : {}), clientDiff: true }),
  });
  if (!isObj(body) || typeof body.id !== "string")
    throw new UploadError("upload failed: server did not return a build id");
  const at = body.diffLocation;
  return { id: body.id, diffLocation: at === "ci" || at === "server" ? at : undefined };
}

/** Keys per baselines request: the server takes up to 2000. */
const KEYS_PER_REQUEST = 500;

function snapshotKey(e: SnapshotEntry) {
  const { name, platform, browser, viewport, theme } = snapshotMeta(e);
  return { name, platform, browser, viewport, theme };
}

/** The server's pick for every shot, in manifest order. */
async function fetchBaselines(
  client: Client,
  id: string,
  entries: SnapshotEntry[],
): Promise<{ diffLocation: DiffLocation; picks: BaselinePick[] }> {
  const picks: BaselinePick[] = [];
  let diffLocation: DiffLocation = "server";
  for (let i = 0; i < entries.length; i += KEYS_PER_REQUEST) {
    const reply = await send(client, {
      step: "fetch baselines",
      method: "POST",
      path: `/api/v1/builds/${id}/baselines`,
      body: JSON.stringify({ keys: entries.slice(i, i + KEYS_PER_REQUEST).map(snapshotKey) }),
    });
    const sent: unknown[] = isObj(reply) && Array.isArray(reply.baselines) ? reply.baselines : [];
    if (sent.length === 0 || !sent.every(isBaselinePick))
      throw new UploadError("upload failed: fetch baselines: the server's reply has no baselines");
    if (isObj(reply) && reply.diff_location === "ci") diffLocation = "ci";
    picks.push(...sent);
  }
  return { diffLocation, picks };
}

/** A baseline image, through the signed link the server gave, on the server the CLI was pointed at. */
function baselinePng(client: Client, picked: PickedShot): Promise<Buffer> {
  const url = new URL(picked.image_url, client.base);
  return sendPng(client, {
    step: `fetch baseline ${picked.id}`,
    method: "GET",
    path: `${url.pathname}${url.search}`,
  });
}

/**
 * One shot's upload: its meta and PNG; in a CI project, what it measured against each baseline;
 * and for a flaky shot, the flake record and every re-capture as `flake:<run>` (ob 1737).
 */
function snapshotForm(
  e: SnapshotEntry,
  png: Buffer,
  results: CiResult[],
  flake: FlakeCheck | undefined,
): FormData {
  const form = new FormData();
  const meta: Record<string, unknown> = snapshotMeta(e);
  if (results.length > 0) {
    meta.ci = {
      engineVersion: ENGINE_VERSION,
      results: results.map(({ baselineId, status, diffResult }) => ({
        baselineId,
        status,
        diffResult,
      })),
    };
    for (const r of results)
      form.set(`diff:${r.baselineId}`, new File([new Uint8Array(r.mask)], "diff.png"));
  }
  if (flake?.flaky) {
    meta.flake = flake.record;
    for (const r of flake.retries)
      form.set(`flake:${r.run}`, new File([new Uint8Array(r.png)], `run${r.run}.png`));
  }
  form.set("meta", JSON.stringify(meta));
  form.set("file", new File([new Uint8Array(png)], "shot.png"));
  return form;
}

/**
 * Send a snapshot dir to a PixelSlash server: open a build, upload each PNG, finalise.
 * The only network this package does for a page shot, and only to `server`. If anything
 * fails the build is left open on the server (unfinalised, uncounted) and this throws.
 */
export async function uploadSnapshots(
  opts: UploadOptions,
  deps: UploadDeps = {},
): Promise<UploadResult> {
  const env = deps.env ?? process.env;
  if (!isHttpUrl(opts.server))
    throw new UsageError(`server must be an http(s) URL: ${opts.server}`);
  const base = opts.server.replace(/\/+$/, "");
  const fetcher = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const manifest = await readManifest(opts.dir);
  const warn = deps.warn ?? (() => {});
  const ctx = await gitContext({ ...opts.git, env, warn });
  const client: Client = {
    fetch: fetcher,
    base,
    token: opts.token,
    warn,
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
  };
  const { id, diffLocation } = await openBuild(client, ctx, opts.projectId);
  // A server from before ob 1727 has no baselines endpoint and diffs every build itself.
  const picked = diffLocation
    ? await fetchBaselines(client, id, manifest.snapshots)
    : { diffLocation: "server", picks: [] };
  const ci = picked.diffLocation === "ci";
  const flakes = flakePass({
    dir: opts.dir,
    retries: opts.flakeRetries ?? DEFAULT_FLAKE_RETRIES,
    recapture: deps.recapture,
    warn,
  });
  await clearFlakeOutput(opts.dir);
  const queue = manifest.snapshots.map((e, i) => ({ e, pick: picked.picks[i] }));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { e, pick } = next;
      const png = Buffer.from(await Bun.file(pngPath(opts.dir, e)).arrayBuffer());
      // A server project measures at finalise; here its diff only decides whether to re-capture,
      // and is never sent as the shot's result.
      const results =
        pick && (ci || flakes.retries > 0)
          ? await measureShot(e, png, pick, (p) => baselinePng(client, p))
          : [];
      if (results.length > 0) flakes.measured();
      const changed = results.some((r) => r.status === "changed");
      const flake = changed ? await flakes.check(e, png) : undefined;
      await send(client, {
        step: `upload ${identity(e)}`,
        method: "PUT",
        path: `/api/v1/builds/${id}/snapshots`,
        body: snapshotForm(e, png, ci ? results : [], flake),
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  checkOutcome(client, id, await finalise(client, id, manifest.snapshots.length));
  const outcome = await flakes.finish(manifest.snapshots);
  return { buildId: id, snapshots: manifest.snapshots.length, git: ctx, ...outcome };
}

function snapshotMeta(e: SnapshotEntry) {
  return {
    name: e.name,
    platform: PLATFORM,
    browser: e.variant.browser,
    viewport: `${e.variant.viewport.width}x${e.variant.viewport.height}`,
    theme: e.variant.theme,
    tags: e.tags,
    diff: e.diff,
    ignore: e.ignore,
    fingerprint: e.fingerprint,
    flaky: e.flaky,
  };
}
