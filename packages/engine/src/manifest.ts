import { join, resolve, sep } from "node:path";
import { type FlakyPolicy, parseFlaky } from "./config-flake.ts";
import { type MaskRect, parseArea } from "./config-areas.ts";
import { parseDiffOptions } from "./diff-options.ts";
import { UsageError } from "./errors.ts";
import type { SnapshotEntry, SnapshotManifest } from "./snapshot.ts";
import { isObj } from "./upload-client.ts";

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

/** A manifest entry's flaky policy; one written before the field existed is `"review"`. */
function policy(v: unknown, where: string): FlakyPolicy {
  return parseFlaky(v, where, bad) ?? "review";
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
    flaky: policy(v.flaky, `${where}.flaky`),
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
export function pngPath(dir: string, e: SnapshotEntry): string {
  const root = resolve(dir);
  const path = resolve(root, e.file);
  if (!path.startsWith(root + sep)) throw new UsageError(`manifest: ${e.file} is outside ${dir}`);
  return path;
}
