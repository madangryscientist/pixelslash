#!/usr/bin/env bun
/**
 * `bun run bench:import-flags` (ob 1734): turn reviewers' detection flags (ob 1721) into bench
 * cases, so the diff is tuned against real misses and stays fixed. Our tooling, not a CLI command.
 *
 *   bun bench/src/import-flags.ts [--server URL] [--project ID|NAME] [--to DIR] [<flag-id>...]
 *
 * With ids, each flag's baseline and head PNGs are downloaded into `<to>/<case>/` beside a
 * `label.json` in the corpus's format, and the flag is marked exported on the server. A `missed`
 * flag is a `real` case whose box is the flagged rect (the whole image when it has none); a
 * `false_positive` is a `noise` case. Without ids, it lists the flags not yet exported.
 *
 * The token is `PIXELSLASH_TOKEN`, else what `pixelslash login` stored for the server; it must be
 * a personal one (`psu_…`), because only a person marks a flag exported. Nothing is added to
 * `bench/corpus*`: moving a case there is a decision (bench/README.md, "Imported cases").
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BENCH_DIR, isRecord } from "./corpus.ts";
import type { Rect } from "./regions.ts";
import { say, warn } from "./say.ts";

const USAGE =
  "usage: bun run bench:import-flags [--server URL] [--project ID|NAME] [--to DIR] [<flag-id>...]";

export const DEFAULT_TO = join(BENCH_DIR, "imported");

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Api = { server: string; token: string; fetch: FetchLike };

/** The fields of an API v1 detection flag this script reads (`docs/cli.md`, "A detection flag"). */
export type Flag = {
  id: string;
  kind: "missed" | "false_positive";
  note: string | null;
  rect: Rect | null;
  by: string;
  snapshot: Record<string, unknown> & { name: string };
  build: Record<string, unknown>;
  measured: unknown;
  images: { head: string | null; baseline: string | null };
  createdAt: string;
  exportedAt: string | null;
  webUrl: string;
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function rectOf(v: unknown): Rect | null {
  if (!isRecord(v)) return null;
  const { x, y, w, h } = v;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (typeof w !== "number" || typeof h !== "number") return null;
  return { x, y, w, h };
}

export function parseFlag(raw: unknown): Flag {
  if (!isRecord(raw)) throw new Error("a detection flag is not an object");
  const { kind, snapshot, build, images } = raw;
  if (kind !== "missed" && kind !== "false_positive")
    throw new Error(`bad flag kind: ${text(kind)}`);
  if (!isRecord(snapshot) || !isRecord(build) || !isRecord(images))
    throw new Error(`flag ${text(raw.id)} has no snapshot, build or images`);
  return {
    id: text(raw.id),
    kind,
    note: textOrNull(raw.note),
    rect: rectOf(raw.rect),
    by: text(raw.by),
    snapshot: { ...snapshot, name: text(snapshot.name) },
    build,
    measured: raw.measured ?? null,
    images: { head: textOrNull(images.head), baseline: textOrNull(images.baseline) },
    createdAt: text(raw.created_at),
    exportedAt: textOrNull(raw.exported_at),
    webUrl: text(raw.web_url),
  };
}

async function call(api: Api, method: "GET" | "POST", path: string) {
  const res = await api.fetch(`${api.server}${path}`, {
    method,
    headers: { authorization: `Bearer ${api.token}` },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = isRecord(body) && isRecord(body.error) ? text(body.error.message) : "";
    throw new Error(`${method} ${path}: ${res.status}${error ? ` ${error}` : ""}`);
  }
  if (!isRecord(body)) throw new Error(`${method} ${path}: the reply is not a JSON object`);
  return body;
}

/** `--project` by id or name, else every project the token reaches. */
async function projectIds(api: Api, wanted: string | undefined): Promise<string[]> {
  const body = await call(api, "GET", "/api/v1/projects");
  const projects = (Array.isArray(body.projects) ? body.projects : []).filter(isRecord);
  if (wanted === undefined) return projects.map((p) => text(p.id));
  const found = projects.filter((p) => p.id === wanted || p.name === wanted);
  if (found.length !== 1)
    throw new Error(
      `--project ${wanted} names ${found.length} projects; the token sees: ${projects.map((p) => `${text(p.name)} (${text(p.id)})`).join(", ")}`,
    );
  return found.map((p) => text(p.id));
}

/** Every flag of the projects, newest first, following `next_cursor`. */
export async function listFlags(api: Api, project?: string): Promise<Flag[]> {
  const flags: Flag[] = [];
  for (const id of await projectIds(api, project)) {
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const body = await call(
        api,
        "GET",
        `/api/v1/projects/${encodeURIComponent(id)}/detection-flags?limit=100${query}`,
      );
      const page = Array.isArray(body.detection_flags) ? body.detection_flags : [];
      flags.push(...page.map(parseFlag));
      cursor = textOrNull(body.next_cursor);
    } while (cursor);
  }
  return flags;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk; throws on bytes that are not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function download(api: Api, url: string, what: string): Promise<Buffer> {
  const res = await api.fetch(url);
  if (!res.ok) throw new Error(`${what}: ${res.status} from ${url}`);
  const png = Buffer.from(await res.arrayBuffer());
  pngSize(png);
  return png;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40) || "shot";

export function caseName(flag: Flag): string {
  const kind = flag.kind === "missed" ? "missed" : "false-positive";
  return `flag-${kind}-${slug(flag.snapshot.name)}-${flag.id.slice(0, 8)}`;
}

/**
 * The case's `label.json`: the corpus's fields (`parseLabel` reads them) and the flag it came from
 * under `flag`, which the bench ignores. `wholeImage` says a missed flag named no area.
 */
export function caseLabel(flag: Flag, head: { width: number; height: number }) {
  const wholeImage = flag.kind === "missed" && !flag.rect;
  const box = flag.kind === "missed" ? (flag.rect ?? { x: 0, y: 0, ...wh(head) }) : undefined;
  return {
    wholeImage,
    label: {
      label: flag.kind === "missed" ? "real" : "noise",
      kind: flag.kind === "missed" ? "flag-missed" : "flag-false-positive",
      page: flag.snapshot.name,
      width: head.width,
      height: head.height,
      ...(box ? { box } : {}),
      flag: {
        id: flag.id,
        kind: flag.kind,
        note: flag.note,
        by: flag.by,
        rect: flag.rect,
        box_from: boxFrom(box, wholeImage),
        snapshot: flag.snapshot,
        build: flag.build,
        measured: flag.measured,
        created_at: flag.createdAt,
        web_url: flag.webUrl,
      },
    },
  };
}

function boxFrom(box: Rect | undefined, wholeImage: boolean) {
  if (!box) return null;
  return wholeImage ? "whole-image" : "rect";
}

const wh = (s: { width: number; height: number }) => ({ w: s.width, h: s.height });

function expectation(label: string, wholeImage: boolean): string {
  if (label !== "real") return "noise: expected not changed";
  return wholeImage
    ? "real, the flag has no rect: the whole image is the expected region"
    : "real, the flagged rect is the expected region";
}

/** Write one flag's case under `to`, replacing an earlier import of it; returns what it did. */
export async function importFlag(api: Api, flag: Flag, to: string): Promise<string> {
  const { head: headUrl, baseline: baseUrl } = flag.images;
  if (!headUrl || !baseUrl)
    throw new Error(`flag ${flag.id}: the shot has no baseline (a new shot), so there is no pair`);
  const [base, head] = await Promise.all([
    download(api, baseUrl, `flag ${flag.id} baseline`),
    download(api, headUrl, `flag ${flag.id} head`),
  ]);
  const { label, wholeImage } = caseLabel(flag, pngSize(head));
  const dir = join(to, caseName(flag));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "base.png"), base);
  writeFileSync(join(dir, "head.png"), head);
  writeFileSync(join(dir, "label.json"), `${JSON.stringify(label, null, 2)}\n`);
  await call(api, "POST", `/api/v1/detection-flags/${encodeURIComponent(flag.id)}/exported`).catch(
    (e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(
        `flag ${flag.id}: the case is in ${dir}, but it was not marked exported: ${why}`,
      );
    },
  );
  return `${flag.id} -> ${dir} (${expectation(label.label, wholeImage)})`;
}

/** One line per flag not yet exported, for choosing ids. */
export function listing(flags: Flag[]): string {
  const open = flags.filter((f) => !f.exportedAt);
  if (open.length === 0) return "no detection flags left to export";
  const rows = open.map((f) =>
    [
      f.id,
      f.kind,
      f.snapshot.name,
      text(f.build.branch),
      f.by,
      f.createdAt.slice(0, 10),
      f.note ?? "",
    ].join("  "),
  );
  return `${open.length} flag(s) not yet exported:\n${rows.join("\n")}`;
}

type Args = { server?: string; project?: string; to: string; ids: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { to: DEFAULT_TO, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--server") args.server = value();
    else if (a === "--project") args.project = value();
    else if (a === "--to") args.to = resolve(value());
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}\n${USAGE}`);
    else args.ids.push(a);
  }
  return args;
}

/** `pixelslash login`'s store (packages/cli/src/credentials.ts): `{ servers: { <url>: { token } } }`. */
function storedTokens(env: NodeJS.ProcessEnv): Record<string, string> {
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const path = join(config, "pixelslash", "credentials.json");
  if (!existsSync(path)) return {};
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const servers = isRecord(raw) && isRecord(raw.servers) ? raw.servers : {};
  const tokens: Record<string, string> = {};
  for (const [server, entry] of Object.entries(servers))
    if (isRecord(entry) && typeof entry.token === "string") tokens[server] = entry.token;
  return tokens;
}

function pickServer(named: string | undefined, known: string[]): string {
  const server = named ?? (known.length === 1 ? known[0] : undefined);
  if (!server)
    throw new Error(
      `need --server URL or PIXELSLASH_SERVER (logged in to: ${known.join(", ") || "none"})`,
    );
  return server.replace(/\/+$/, "");
}

/** `--server`, else `PIXELSLASH_SERVER`, else the one server logged in to. */
export function resolveApi(
  args: { server?: string | undefined },
  env: NodeJS.ProcessEnv,
  fetch: FetchLike,
): Api {
  const stored = storedTokens(env);
  const server = pickServer(args.server ?? env.PIXELSLASH_SERVER, Object.keys(stored));
  const token = env.PIXELSLASH_TOKEN?.trim() || stored[server];
  if (!token)
    throw new Error(
      `no token for ${server}: run \`pixelslash login --server ${server}\` or set PIXELSLASH_TOKEN`,
    );
  if (!token.startsWith("psu_"))
    throw new Error("a personal token (psu_…) is needed: only a person marks a flag exported");
  return { server, token, fetch };
}

/** Exit 1 when an id was not found or did not become a case; the rest are still imported. */
export async function run(argv: string[], env: NodeJS.ProcessEnv, fetch: FetchLike) {
  const args = parseArgs(argv);
  const api = resolveApi(args, env, fetch);
  const flags = await listFlags(api, args.project);
  if (args.ids.length === 0) {
    say(listing(flags));
    return 0;
  }
  let failed = 0;
  for (const id of args.ids) {
    const flag = flags.find((f) => f.id === id);
    try {
      if (!flag) throw new Error(`flag ${id}: not found in the projects this token sees`);
      say(await importFlag(api, flag, args.to));
    } catch (e) {
      failed++;
      warn(e instanceof Error ? e.message : String(e));
    }
  }
  say(
    `${args.ids.length - failed} of ${args.ids.length} imported and marked exported; move a case into bench/corpus*/ to have bench:check guard it (bench/README.md)`,
  );
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await run(
      process.argv.slice(2),
      process.env,
      globalThis.fetch.bind(globalThis),
    );
  } catch (e) {
    warn(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
