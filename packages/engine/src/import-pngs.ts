import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";
import type { SnapshotEntry, SnapshotManifest } from "./snapshot.ts";
import { checkPng, identity } from "./manifest.ts";
import { readPngSize } from "./identical.ts";
import { METRICS_SUFFIX } from "./metrics-entry.ts";
import { checkMetrics } from "./metrics-file.ts";
import { DEVICE_LABEL, expectedPixels, type NativePlatform } from "./native.ts";

export type ImportOptions = {
  /** A dir of PNGs, any depth. Each PNG's path under it, without `.png`, is the snapshot's name. */
  dir: string;
  /** The snapshot dir to write: the PNGs copied in, and `manifest.json`. */
  out: string;
  /**
   * The logical size every shot is filed under. Optional for a native import: it is then each PNG's
   * pixel size divided by `scale`, rounded. A web import always gives one.
   */
  viewport?: { width: number; height: number };
  theme: "light" | "dark";
  /** What took the shots, e.g. `cypress 13`. Only snapshots with equal renderers are compared. */
  renderer: string;
  /**
   * `android` or `ios` for shots from Maestro (PS-293), with the `device` label and the device pixel
   * ratio `scale`. Absent for web, whose entries then carry none of the three.
   */
  platform?: NativePlatform;
  device?: string;
  scale?: number;
};

export type ImportResult = {
  manifest: SnapshotManifest;
  manifestPath: string;
  /**
   * What the import worked out rather than was told, one line each: a viewport derived from a PNG
   * size, or a PNG whose size is not viewport × scale. Empty for web.
   */
  notes: string[];
};

/** The fingerprint's image and fonts for shots whose renderer we did not run and cannot read. */
const EXTERNAL = "external";
const UNKNOWN_FONTS = "unknown";

const PNG_FILE = /\.png$/i;

/**
 * Every `.png` under `dir`, and every `<name>.metrics.json` (PS-294), as `/`-separated paths relative
 * to it, sorted. Other files are left alone.
 */
async function scan(dir: string): Promise<{ pngs: string[]; metrics: string[] }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => {
    throw new UsageError(`${dir} is not a directory`);
  });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"));
  return {
    pngs: files.filter((f) => PNG_FILE.test(f)).toSorted(),
    metrics: files.filter((f) => f.endsWith(METRICS_SUFFIX)).toSorted(),
  };
}

/** The metrics file that sits beside a PNG: `home.png` has `home.metrics.json`. */
const metricsBeside = (png: string): string => png.replace(PNG_FILE, METRICS_SUFFIX);

const WEB_DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * The one rule for a native PNG whose size is not viewport × scale (PS-293): it is accepted, the
 * entry keeps the viewport and the scale it was given, and the note names both sizes. A real device
 * rarely divides evenly (a Pixel 8 at 2.625 is 1080×2400 for a 411×914 viewport), and refusing would
 * refuse the real shot. The diff itself only ever compares two PNGs.
 */
async function nativeViewport(
  dir: string,
  file: string,
  o: ImportOptions & { scale: number },
  notes: string[],
): Promise<{ width: number; height: number }> {
  const size = readPngSize(
    new Uint8Array(await Bun.file(join(dir, file)).slice(0, 32).arrayBuffer()),
  );
  if (!size) throw new UsageError(`${file} is not a readable PNG`);
  if (!o.viewport) {
    const derived = {
      width: Math.max(1, Math.round(size.width / o.scale)),
      height: Math.max(1, Math.round(size.height / o.scale)),
    };
    notes.push(
      `${file}: ${size.width}x${size.height} px at scale ${o.scale} is viewport ${derived.width}x${derived.height}`,
    );
    return derived;
  }
  const want = expectedPixels(o.viewport, o.scale);
  if (want.width !== size.width || want.height !== size.height)
    notes.push(
      `${file}: ${size.width}x${size.height} px, but viewport ${o.viewport.width}x${o.viewport.height} at scale ${o.scale} is ${want.width}x${want.height}; filed as given`,
    );
  return o.viewport;
}

function entryFor(
  file: string,
  o: ImportOptions,
  viewport: { width: number; height: number },
): SnapshotEntry {
  const name = file.replace(PNG_FILE, "");
  const native =
    o.platform && o.device !== undefined && o.scale !== undefined
      ? { platform: o.platform, device: o.device, scale: o.scale }
      : null;
  return {
    name,
    path: file,
    variant: { name: o.theme, browser: "chromium", viewport, theme: o.theme },
    tags: [],
    diff: {},
    ignore: [],
    flaky: "review",
    file,
    fingerprint: {
      image: EXTERNAL,
      browser: o.renderer,
      fonts: UNKNOWN_FONTS,
      ...(native && {
        platform: native.platform,
        device: native.device,
        scale: String(native.scale),
      }),
    },
    ...native,
  };
}

/** Native flags travel together: a platform needs its device and scale, and web takes neither. */
function checkNative(o: ImportOptions): (ImportOptions & { scale: number }) | null {
  if (!o.platform) {
    if (o.device !== undefined || o.scale !== undefined)
      throw new UsageError("--device and --scale are for --platform android|ios");
    return null;
  }
  if (!o.device?.trim()) throw new UsageError(`--platform ${o.platform} needs --device "<label>"`);
  if (!DEVICE_LABEL.test(o.device))
    throw new UsageError(
      `--device "${o.device}" must be 1 to 80 letters, digits, spaces or _.()+,:/- (it starts with a letter or digit)`,
    );
  if (o.scale === undefined || !Number.isFinite(o.scale) || o.scale <= 0)
    throw new UsageError(
      `--platform ${o.platform} needs --scale N (the device pixel ratio, above 0)`,
    );
  return { ...o, scale: o.scale };
}

function refuseOverlap(out: string, dir: string): void {
  if (out === dir || out.startsWith(dir + sep) || dir.startsWith(out + sep))
    throw new UsageError(`--out ${out} overlaps the PNG dir ${dir}`);
}

/** A metrics file is checked before anything is written: no PNG beside it, or malformed, is exit 2. */
async function checkMetricsFiles(dir: string, files: string[], metricsFiles: string[]) {
  const beside = new Set(files.map(metricsBeside));
  for (const m of metricsFiles)
    if (!beside.has(m))
      throw new UsageError(`${m} has no ${m.slice(0, -METRICS_SUFFIX.length)}.png beside it`);
  for (const m of metricsFiles)
    checkMetrics(m, new Uint8Array(await Bun.file(join(dir, m)).arrayBuffer()));
}

/** The entry with its `<name>.metrics.json` beside the PNG, when there is one. */
function withMetrics(entry: SnapshotEntry, metricsFiles: string[]): SnapshotEntry {
  const metrics = metricsBeside(entry.file);
  return metricsFiles.includes(metrics) ? { ...entry, metrics } : entry;
}

/** The PNGs, and each one's metrics file, copied into the snapshot dir. */
async function copyShots(dir: string, out: string, snapshots: SnapshotEntry[]) {
  for (const e of snapshots) {
    for (const f of e.metrics ? [e.file, e.metrics] : [e.file]) {
      await mkdir(dirname(join(out, f)), { recursive: true });
      await copyFile(join(dir, f), join(out, f));
    }
  }
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
  const { pngs: files, metrics: metricsFiles } = await scan(dir);
  if (files.length === 0) throw new UsageError(`no .png files in ${dir}`);
  await checkMetricsFiles(dir, files, metricsFiles);
  const native = checkNative(options);
  const notes: string[] = [];
  const snapshots: SnapshotEntry[] = [];
  for (const f of files) {
    const viewport = native
      ? await nativeViewport(dir, f, native, notes)
      : (options.viewport ?? WEB_DEFAULT_VIEWPORT);
    const entry = entryFor(f, options, viewport);
    snapshots.push(withMetrics(entry, metricsFiles));
  }
  const seen = new Set<string>();
  for (const e of snapshots) {
    if (e.name === "") throw new UsageError(`${e.file} has no name before .png`);
    await checkPng(dir, e);
    const id = identity(e);
    if (seen.has(id)) throw new UsageError(`two PNGs are named ${e.name} (${e.file})`);
    seen.add(id);
  }
  await copyShots(dir, out, snapshots);
  const manifest: SnapshotManifest = { version: 1, snapshots };
  const manifestPath = join(out, "manifest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath, notes };
}
