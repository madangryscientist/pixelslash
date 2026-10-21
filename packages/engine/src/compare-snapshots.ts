import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { diffPngs } from "./diff.ts";
import { UsageError } from "./errors.ts";
import type { Fingerprint } from "./fingerprint.ts";
import { renderCompareIndex, type CompareRow } from "./compare-report.ts";
import { renderPixelReport } from "./report.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import { identity, readManifest } from "./upload.ts";

export type SnapshotCompareOptions = {
  mainDir: string;
  branchDir: string;
  out: string;
};

export type SnapshotCompareDeps = { warn?: (message: string) => void };

export type SnapshotCompareResult = {
  indexPath: string;
  changed: CompareRow[];
  unchanged: CompareRow[];
  /** In Branch only. */
  added: CompareRow[];
  /** In Main only. */
  removed: CompareRow[];
  /** Matched snapshots whose two sides were rendered by different environments. */
  mismatched: CompareRow[];
};

const FINGERPRINT_KEYS = ["image", "browser", "fonts"] as const;

/** The fingerprint fields that differ between two sides; empty when the environments agree. */
function fingerprintDiff(a: Fingerprint, b: Fingerprint): string[] {
  return FINGERPRINT_KEYS.filter((k) => a[k] !== b[k]);
}

/** A path segment from a name: a hand-edited manifest may hold anything, `index.html` included. */
function segment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^(\.+|index\.html)$/, "-$1");
}

/** `name/chromium-1280x720-light`, unique per identity even when two names sanitise alike. */
function dirFor(e: SnapshotEntry, taken: Set<string>): string {
  const { width, height } = e.variant.viewport;
  const base = `${segment(e.name)}/${e.variant.browser}-${width}x${height}-${e.variant.theme}`;
  let dir = base;
  for (let n = 2; taken.has(dir); n++) dir = `${base}-${n}`;
  taken.add(dir);
  return dir;
}

/**
 * The shot's identity without its name. The colour scheme is what the browser was asked to prefer
 * (`prefers: dark`), so it is named as such, and only when this compare varied it: a run that shot
 * everything in one scheme does not print it on every card. A Storybook global shows in the name.
 */
function shotLabel(e: SnapshotEntry, varied: boolean): string {
  const { width, height } = e.variant.viewport;
  const base = `${e.variant.browser} ${width}x${height}`;
  return varied ? `${base} prefers: ${e.variant.theme}` : base;
}

function rowOf(e: SnapshotEntry, varied: boolean): CompareRow {
  return {
    name: e.name,
    shot: shotLabel(e, varied),
    report: undefined,
    changedPixels: 0,
    mismatch: [],
  };
}

async function readPng(dir: string, e: SnapshotEntry): Promise<Buffer> {
  return Buffer.from(await Bun.file(join(dir, e.file)).arrayBuffer());
}

/**
 * Both sides' ignore areas, like the server: an element that moved is covered at its old and its
 * new place. The diff options are the Branch entry's, also like the server.
 */
async function diffMatch(
  paths: { main: string; branch: string; out: string; varied: boolean },
  main: SnapshotEntry,
  branch: SnapshotEntry,
  dir: string,
): Promise<{ row: CompareRow; changed: boolean }> {
  const row = {
    ...rowOf(branch, paths.varied),
    mismatch: fingerprintDiff(main.fingerprint, branch.fingerprint),
  };
  const mainPng = await readPng(paths.main, main);
  const branchPng = await readPng(paths.branch, branch);
  let diff;
  try {
    diff = diffPngs(mainPng, branchPng, branch.diff, {
      main: main.ignore,
      branch: branch.ignore,
    });
  } catch (e) {
    throw new UsageError(
      `${branch.name}: cannot diff ${main.file} against ${branch.file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  row.changedPixels = diff.changedPixels;
  if (!diff.changed) return { row, changed: false };
  const dest = join(paths.out, dir);
  await mkdir(dest, { recursive: true });
  await Bun.write(join(dest, "main.png"), mainPng);
  await Bun.write(join(dest, "branch.png"), branchPng);
  await Bun.write(join(dest, "diff.png"), diff.overlay);
  await Bun.write(
    join(dest, "report.html"),
    renderPixelReport({
      path: `${branch.name} · ${row.shot}`,
      changedPixels: diff.changedPixels,
      changed: diff.changed,
      diff: branch.diff,
      regions: diff.regions,
      specks: diff.specks,
      ignoredPixels: diff.ignoredPixels,
      ignored: diff.ignored,
      main: { width: diff.mainWidth, height: diff.mainHeight },
      branch: { width: diff.branchWidth, height: diff.branchHeight },
    }),
  );
  row.report = `${dir}/report.html`;
  return { row, changed: true };
}

function refuseOverlap(out: string, dirs: string[]): void {
  for (const dir of dirs) {
    const root = resolve(dir);
    if (out === root || out.startsWith(root + sep) || root.startsWith(out + sep))
      throw new UsageError(`--out ${out} overlaps the snapshot dir ${root}`);
  }
}

/**
 * Diff two `capture` snapshot dirs, no design system and no server. Entries match on the identity
 * the server keeps a snapshot under (name + browser + viewport + theme). A matched pair goes through
 * the engine's `diffPngs` with the same inputs the server gives it, and a changed one gets a
 * `report.html`. Different fingerprints are warned about by name and still diffed.
 */
export async function compareSnapshots(
  opts: SnapshotCompareOptions,
  deps: SnapshotCompareDeps = {},
): Promise<SnapshotCompareResult> {
  const out = resolve(opts.out);
  refuseOverlap(out, [opts.mainDir, opts.branchDir]);
  const main = await readManifest(opts.mainDir);
  const branch = await readManifest(opts.branchDir);
  const schemes = new Set([...main.snapshots, ...branch.snapshots].map((e) => e.variant.theme));
  const varied = schemes.size > 1;
  const mainBy = new Map(main.snapshots.map((e) => [identity(e), e]));
  const branchIds = new Set(branch.snapshots.map(identity));
  const result: SnapshotCompareResult = {
    indexPath: join(out, "index.html"),
    changed: [],
    unchanged: [],
    added: [],
    removed: [],
    mismatched: [],
  };
  const taken = new Set<string>();
  await mkdir(out, { recursive: true });
  for (const e of branch.snapshots) {
    const before = mainBy.get(identity(e));
    if (!before) {
      result.added.push(rowOf(e, varied));
      continue;
    }
    const paths = { main: opts.mainDir, branch: opts.branchDir, out, varied };
    const { row, changed } = await diffMatch(paths, before, e, dirFor(e, taken));
    if (row.mismatch.length > 0) {
      result.mismatched.push(row);
      deps.warn?.(
        `warning: ${row.name} (${row.shot}): rendered by a different ${row.mismatch.join(", ")}; diffing anyway`,
      );
    }
    (changed ? result.changed : result.unchanged).push(row);
  }
  for (const e of main.snapshots)
    if (!branchIds.has(identity(e))) result.removed.push(rowOf(e, varied));
  await Bun.write(result.indexPath, renderCompareIndex(result));
  return result;
}
