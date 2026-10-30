import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { diffA11y } from "./a11y-entry.ts";
import { diffPngs } from "./diff.ts";
import { UsageError } from "./errors.ts";
import type { Fingerprint } from "./fingerprint.ts";
import { renderCompareIndex, rowLabel, type CompareRow } from "./compare-report.ts";
import { withTimings } from "./report-timings.ts";
import { renderPixelReport } from "./report.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import { identity, readManifest } from "./manifest.ts";
import { buildTimings, elapsed, type ShotTiming, type Timings } from "./timings.ts";

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
  /** Matched snapshots the diff threw on (PS-223): not measured, so in none of the other lists. */
  failed: CompareRow[];
  /** The diff of each matched shot, and the run's total (ob 1791); `check` adds its capture and upload. */
  timings: Timings;
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
export function shotKeyLabel(
  k: { browser: string; viewport: string; theme: string },
  varied: boolean,
): string {
  const base = `${k.browser} ${k.viewport}`;
  return varied ? `${base} prefers: ${k.theme}` : base;
}

function shotLabel(e: SnapshotEntry, varied: boolean): string {
  const { width, height } = e.variant.viewport;
  return shotKeyLabel({ ...e.variant, viewport: `${width}x${height}` }, varied);
}

function rowOf(e: SnapshotEntry, varied: boolean): CompareRow {
  return {
    name: e.name,
    shot: shotLabel(e, varied),
    report: undefined,
    changedPixels: 0,
    mismatch: [],
    key: identity(e),
    regions: [],
  };
}

async function readPng(dir: string, e: SnapshotEntry): Promise<Buffer> {
  return Buffer.from(await Bun.file(join(dir, e.file)).arrayBuffer());
}

/** `row` with Branch's accessibility findings against Main's (PS-238); a shot that was not scanned gains nothing. */
function withA11y<R extends CompareRow>(
  row: R,
  main: SnapshotEntry | undefined,
  branch: SnapshotEntry,
): R {
  const a11y = diffA11y(main?.a11y, branch.a11y);
  return a11y.state === "off" ? row : { ...row, a11y };
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
): Promise<{ row: CompareRow; changed: boolean; diffMs: number }> {
  const row = withA11y(
    {
      ...rowOf(branch, paths.varied),
      mismatch: fingerprintDiff(main.fingerprint, branch.fingerprint),
    },
    main,
    branch,
  );
  const mainPng = await readPng(paths.main, main);
  const branchPng = await readPng(paths.branch, branch);
  let diff;
  const started = performance.now();
  try {
    diff = diffPngs(mainPng, branchPng, branch.diff, {
      main: main.ignore,
      branch: branch.ignore,
    });
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    return { row, changed: false, diffMs: 0 };
  }
  const diffMs = elapsed(started);
  row.changedPixels = diff.changedPixels;
  if (!diff.changed) return { row, changed: false, diffMs };
  row.regions = diff.regions;
  const dest = join(paths.out, dir);
  await mkdir(dest, { recursive: true });
  await Bun.write(join(dest, "main.png"), mainPng);
  await Bun.write(join(dest, "branch.png"), branchPng);
  if (diff.overlay) await Bun.write(join(dest, "diff.png"), diff.overlay);
  else await rm(join(dest, "diff.png"), { force: true });
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
      browser: branch.variant.browser,
      main: { width: diff.mainWidth, height: diff.mainHeight },
      branch: { width: diff.branchWidth, height: diff.branchHeight },
    }),
  );
  row.report = `${dir}/report.html`;
  return { row, changed: true, diffMs };
}

/** `not compared: home (chromium 1280x720): <why>`: a shot the diff threw on, for the CLI to print. */
export function notComparedLines(input: { failed: CompareRow[] }): string[] {
  return input.failed.map((r) => `not compared: ${rowLabel(r)}: ${r.error}`);
}

/** One line naming every shot the diff threw on, for the greppable `FAILED` line. */
export function notComparedSummary(input: { failed: CompareRow[] }): string {
  const n = input.failed.length;
  return `${n} shot${n === 1 ? "" : "s"} not compared: ${input.failed.map(rowLabel).join(", ")}`;
}

/** For a caller that has no `not compared` state of its own (`check`, `dev`): a shot the diff threw on fails it. */
export function assertCompared(input: { failed: CompareRow[] }): void {
  if (input.failed.length > 0)
    throw new Error([notComparedSummary(input), ...notComparedLines(input)].join("\n"));
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
  const started = performance.now();
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
    failed: [],
    timings: { totalMs: 0, shots: [] },
  };
  const shots: ShotTiming[] = [];
  const taken = new Set<string>();
  await mkdir(out, { recursive: true });
  for (const e of branch.snapshots) {
    const before = mainBy.get(identity(e));
    if (!before) {
      result.added.push(withA11y(rowOf(e, varied), undefined, e));
      continue;
    }
    const paths = { main: opts.mainDir, branch: opts.branchDir, out, varied };
    const { row, changed, diffMs } = await diffMatch(paths, before, e, dirFor(e, taken));
    if (row.error !== undefined) {
      result.failed.push(row);
      continue;
    }
    shots.push({ name: identity(e), diffMs });
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
  result.timings = buildTimings(started, shots);
  await Bun.write(result.indexPath, withTimings(renderCompareIndex(result), result.timings));
  return result;
}
