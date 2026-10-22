import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";
import type { SnapshotEntry, SnapshotManifest } from "./snapshot.ts";
import { checkPng, identity } from "./upload.ts";

export type ImportOptions = {
  /** A dir of PNGs, any depth. Each PNG's path under it, without `.png`, is the snapshot's name. */
  dir: string;
  /** The snapshot dir to write: the PNGs copied in, and `manifest.json`. */
  out: string;
  viewport: { width: number; height: number };
  theme: "light" | "dark";
  /** What took the shots, e.g. `cypress 13`. Only snapshots with equal renderers are compared. */
  renderer: string;
};

export type ImportResult = { manifest: SnapshotManifest; manifestPath: string };

/** The fingerprint's image and fonts for shots whose renderer we did not run and cannot read. */
const EXTERNAL = "external";
const UNKNOWN_FONTS = "unknown";

const PNG_FILE = /\.png$/i;

/** Every `.png` under `dir`, as `/`-separated paths relative to it, sorted. Other files are left alone. */
async function pngFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => {
    throw new UsageError(`${dir} is not a directory`);
  });
  return entries
    .filter((e) => e.isFile() && PNG_FILE.test(e.name))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .toSorted();
}

function entryFor(file: string, o: ImportOptions): SnapshotEntry {
  const name = file.replace(PNG_FILE, "");
  return {
    name,
    path: file,
    variant: { name: o.theme, browser: "chromium", viewport: o.viewport, theme: o.theme },
    tags: [],
    diff: {},
    ignore: [],
    file,
    fingerprint: { image: EXTERNAL, browser: o.renderer, fonts: UNKNOWN_FONTS },
  };
}

function refuseOverlap(out: string, dir: string): void {
  if (out === dir || out.startsWith(dir + sep) || dir.startsWith(out + sep))
    throw new UsageError(`--out ${out} overlaps the PNG dir ${dir}`);
}

/**
 * Turn a dir of PNGs from any screenshot tool into a snapshot dir `upload` accepts: the PNGs
 * copied in and a version 1 manifest. Nothing is measured from the shots, so every entry takes the
 * one `viewport` and `theme` given (they are half of a snapshot's identity), the engine's default
 * diff options and no ignore areas, and a fingerprint that says the renderer was not ours.
 */
export async function importPngs(options: ImportOptions): Promise<ImportResult> {
  const dir = resolve(options.dir);
  const out = resolve(options.out);
  refuseOverlap(out, dir);
  const files = await pngFiles(dir);
  if (files.length === 0) throw new UsageError(`no .png files in ${dir}`);
  const snapshots = files.map((f) => entryFor(f, options));
  const seen = new Set<string>();
  for (const e of snapshots) {
    if (e.name === "") throw new UsageError(`${e.file} has no name before .png`);
    await checkPng(dir, e);
    const id = identity(e);
    if (seen.has(id)) throw new UsageError(`two PNGs are named ${e.name} (${e.file})`);
    seen.add(id);
  }
  for (const f of files) {
    await mkdir(dirname(join(out, f)), { recursive: true });
    await copyFile(join(dir, f), join(out, f));
  }
  const manifest: SnapshotManifest = { version: 1, snapshots };
  const manifestPath = join(out, "manifest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
}
