import { join, resolve, sep } from "node:path";
import {
  type BaselinePick,
  type DiffLocation,
  ENGINE_VERSION,
  type PickedShot,
  isBaselinePick,
  measureShot,
} from "./ci-diff.ts";
import { type MaskRect, parseArea } from "./config-areas.ts";
import { isHttpUrl } from "./routes.ts";
import { parseDiffOptions } from "./diff-options.ts";
import { UploadError, UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import { type GitContext, type GitOptions, gitContext } from "./git.ts";
import type { SnapshotEntry, SnapshotManifest } from "./snapshot.ts";
import { type Client, isObj, send, sendPng } from "./upload-client.ts";

/** The pinned capture image is Linux; the manifest carries no platform of its own. */
const PLATFORM = "linux";
const CONCURRENCY = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bad(where: string, what: string): never {
  throw new UsageError(`manifest: ${where} ${what}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v === "") bad(where, "must be a non-empty string");
  return v;
}

function posInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    bad(where, "must be a positive integer");
  return v;
}

/** Ignore rects in image px; a manifest from before ignore areas has none. */
function ignoreRects(v: unknown, where: string): MaskRect[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) bad(where, "must be an array of { x, y, width, height }");
  return v.map((r, i) => {
    const at = `${where}[${i}]`;
    // A selector is a valid area but not a rect, so a string reads like any other non-object.
    const rect = isObj(r) ? parseArea(r, at, bad) : "";
    if (typeof rect === "string") bad(at, "must be an object");
    return rect;
  });
}

function entry(v: unknown, i: number): SnapshotEntry {
  const where = `snapshots[${i}]`;
  if (!isObj(v)) bad(where, "must be an object");
  const { variant, fingerprint, tags } = v;
  if (!isObj(variant) || !isObj(variant.viewport)) bad(`${where}.variant`, "must be an object");
  if (!isObj(fingerprint)) bad(`${where}.fingerprint`, "must be an object");
  if (!Array.isArray(tags)) bad(`${where}.tags`, "must be an array of strings");
  if (variant.theme !== "light" && variant.theme !== "dark")
    bad(`${where}.variant.theme`, 'must be "light" or "dark"');
  if (variant.browser !== "chromium") bad(`${where}.variant.browser`, 'must be "chromium"');
  return {
    name: str(v.name, `${where}.name`),
    path: str(v.path, `${where}.path`),
    variant: {
      name: str(variant.name, `${where}.variant.name`),
      browser: "chromium",
      viewport: {
        width: posInt(variant.viewport.width, `${where}.variant.viewport.width`),
        height: posInt(variant.viewport.height, `${where}.variant.viewport.height`),
      },
      theme: variant.theme,
    },
    tags: tags.map((t, j) => str(t, `${where}.tags[${j}]`)),
    diff: v.diff === undefined ? {} : parseDiffOptions(v.diff, `${where}.diff`, bad),
    ignore: ignoreRects(v.ignore, `${where}.ignore`),
    file: str(v.file, `${where}.file`),
    fingerprint: {
      image: str(fingerprint.image, `${where}.fingerprint.image`),
      browser: str(fingerprint.browser, `${where}.fingerprint.browser`),
      fonts: str(fingerprint.fonts, `${where}.fingerprint.fonts`),
    },
  };
}

/** The identity the server keeps a snapshot under; two entries sharing it would overwrite each other. */
export function identity(e: SnapshotEntry): string {
  const { width, height } = e.variant.viewport;
  return [e.name, e.variant.browser, `${width}x${height}`, e.variant.theme].join(" / ");
}

function parseManifest(raw: unknown): SnapshotManifest {
  if (!isObj(raw) || raw.version !== 1) bad("version", "must be 1");
  if (!Array.isArray(raw.snapshots)) bad("snapshots", "must be an array");
  const snapshots = raw.snapshots.map(entry);
  const seen = new Set<string>();
  for (const e of snapshots) {
    const id = identity(e);
    if (seen.has(id)) bad("snapshots", `has two entries for ${id}`);
    seen.add(id);
  }
  return { version: 1, snapshots };
}

export async function checkPng(dir: string, e: SnapshotEntry): Promise<void> {
  const png = Bun.file(pngPath(dir, e));
  if (!(await png.exists())) throw new UsageError(`manifest: ${e.file} does not exist`);
  const head = Buffer.from(await png.slice(0, 8).arrayBuffer());
  if (!head.equals(PNG_SIGNATURE)) throw new UsageError(`manifest: ${e.file} is not a PNG`);
}

/** Read and validate `dir/manifest.json`, and check every PNG it names is inside `dir` and is a PNG. */
export async function readManifest(dir: string): Promise<SnapshotManifest> {
  const path = join(dir, "manifest.json");
  const file = Bun.file(path);
  if (!(await file.exists())) throw new UsageError(`no manifest.json in ${dir}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (e) {
    throw new UsageError(
      `manifest: ${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const manifest = parseManifest(raw);
  for (const e of manifest.snapshots) await checkPng(dir, e);
  return manifest;
}

/** A manifest names files relative to its dir; one that climbs out of it is refused. */
function pngPath(dir: string, e: SnapshotEntry): string {
  const root = resolve(dir);
  const path = resolve(root, e.file);
  if (!path.startsWith(root + sep)) throw new UsageError(`manifest: ${e.file} is outside ${dir}`);
  return path;
}

export type UploadOptions = {
  dir: string;
  server: string;
  token: string;
  git: Omit<GitOptions, "env" | "warn">;
  /** The project to open the build in: required with a personal token, which reaches several. */
  projectId?: string | undefined;
};

export type UploadDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Where the git checkout and the config are looked for. Default: the process's. */
  cwd?: string;
  warn?: (message: string) => void;
  /** How a retry waits. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type UploadResult = { buildId: string; snapshots: number; git: GitContext };

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

/** One shot's upload: its meta and PNG and, in a CI project, what it measured against each baseline. */
async function snapshotForm(
  client: Client,
  e: SnapshotEntry,
  png: Buffer,
  pick: BaselinePick | undefined,
): Promise<FormData> {
  const form = new FormData();
  const meta: Record<string, unknown> = snapshotMeta(e);
  const results = pick ? await measureShot(e, png, pick, (p) => baselinePng(client, p)) : [];
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
  const queue = manifest.snapshots.map((e, i) => ({ e, pick: picked.picks[i] }));
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { e } = next;
      const png = Buffer.from(await Bun.file(pngPath(opts.dir, e)).arrayBuffer());
      // A server project measures at finalise: nothing is diffed here for it.
      const pick = picked.diffLocation === "ci" ? next.pick : undefined;
      await send(client, {
        step: `upload ${identity(e)}`,
        method: "PUT",
        path: `/api/v1/builds/${id}/snapshots`,
        body: await snapshotForm(client, e, png, pick),
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  checkOutcome(client, id, await finalise(client, id, manifest.snapshots.length));
  return { buildId: id, snapshots: manifest.snapshots.length, git: ctx };
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
  };
}
