import { join, resolve, sep } from "node:path";
import { isHttpUrl } from "./config.ts";
import { UploadError, UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import { type GitContext, type GitOptions, gitContext } from "./git.ts";
import type { SnapshotEntry, SnapshotManifest } from "./snapshot.ts";

/** The pinned capture image is Linux; the manifest carries no platform of its own. */
const PLATFORM = "linux";
const CONCURRENCY = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
    file: str(v.file, `${where}.file`),
    fingerprint: {
      image: str(fingerprint.image, `${where}.fingerprint.image`),
      browser: str(fingerprint.browser, `${where}.fingerprint.browser`),
      fonts: str(fingerprint.fonts, `${where}.fingerprint.fonts`),
    },
  };
}

/** The identity the server keeps a snapshot under; two entries sharing it would overwrite each other. */
function identity(e: SnapshotEntry): string {
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

async function checkPng(dir: string, e: SnapshotEntry): Promise<void> {
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
};

export type UploadDeps = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Where the git checkout and the config are looked for. Default: the process's. */
  cwd?: string;
  warn?: (message: string) => void;
};

export type UploadResult = { buildId: string; snapshots: number; git: GitContext };

type Client = { fetch: FetchLike; base: string; token: string };
type Call = { method: string; path: string; body: string | FormData };

async function failure(res: Response, call: Call): Promise<UploadError> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObj(parsed) && typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // Not JSON: keep the raw text.
  }
  return new UploadError(
    `upload failed: ${call.method} ${call.path} -> ${res.status} ${detail}`.trim(),
  );
}

/** One request to the API; anything but 2xx is an UploadError carrying the server's reason. */
async function send(client: Client, call: Call): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${client.token}` };
  if (typeof call.body === "string") headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await client.fetch(`${client.base}${call.path}`, {
      method: call.method,
      body: call.body,
      headers,
    });
  } catch (e) {
    throw new UploadError(
      `upload failed: ${call.method} ${client.base}${call.path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) throw await failure(res, call);
  return res.json();
}

async function openBuild(client: Client, ctx: GitContext): Promise<string> {
  const body = await send(client, {
    method: "POST",
    path: "/api/v1/builds",
    body: JSON.stringify(ctx),
  });
  if (!isObj(body) || typeof body.id !== "string")
    throw new UploadError("upload failed: server did not return a build id");
  return body.id;
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
  const ctx = await gitContext({
    ...opts.git,
    env,
    warn: deps.warn ?? (() => {}),
  });
  const client: Client = { fetch: fetcher, base, token: opts.token };
  const id = await openBuild(client, ctx);
  const queue = [...manifest.snapshots];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const form = new FormData();
      form.set("meta", JSON.stringify(snapshotMeta(e)));
      form.set("file", new File([await Bun.file(pngPath(opts.dir, e)).arrayBuffer()], "shot.png"));
      await send(client, { method: "PUT", path: `/api/v1/builds/${id}/snapshots`, body: form });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await send(client, {
    method: "POST",
    path: `/api/v1/builds/${id}/finalize`,
    body: JSON.stringify({ snapshots: manifest.snapshots.length }),
  });
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
    fingerprint: e.fingerprint,
  };
}
