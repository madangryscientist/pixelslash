import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MASK_COLOR,
  fontSetHash,
  identity,
  imageId,
  maskLocators,
  measureIgnore,
  pngPath,
  settleCapture,
  toImageRects,
  type Fingerprint,
  type SnapshotEntry,
  type SnapshotManifest,
} from "@pixelslash/engine";
import type { Browser, Page } from "playwright";

/** Add as an init script before pausing the page clock, so the settle keeps real frames. */
export { keepNativeRaf } from "@pixelslash/engine";

export type SnapshotOptions = {
  /** Selectors the diff skips. Measured at the screenshot as boxes in image px; the pixels stay. */
  ignore?: string[];
  /** Selectors painted over in the PNG (MASK_COLOR), so what they show never leaves the machine. */
  redact?: string[];
  /** The variant's name, and the PNG's file name. Default `<width>x<height>-<theme>`. */
  variant?: string;
  tags?: string[];
  /** Default true, as `pixelslash capture` shoots. */
  fullPage?: boolean;
  /** Default `PIXELSLASH_SNAPSHOT_DIR`, else `pixelslash-snapshots` in the working dir. */
  dir?: string;
  /** Bounds the settle (fonts, images, network idle, two frames). Default 8000. */
  timeoutMs?: number;
};

const DEFAULT_DIR = "pixelslash-snapshots";
const DEFAULT_TIMEOUT_MS = 8_000;
/** How long a worker waits for another worker's manifest write before giving up. */
const LOCK_WAIT_MS = 10_000;

/**
 * Browser globals the page callback touches (the tsconfig has no DOM lib). Type-only: the callback
 * is serialized and run in the page, where these are the real globals.
 */
declare const window: {
  devicePixelRatio: number;
  matchMedia(query: string): { matches: boolean };
};
type Size = { width: number; height: number };

/** Hashing the font set reads every font file, so it is done once per worker. */
let fonts: Promise<string> | undefined;

/**
 * Screenshot `page` as the snapshot `name` into the snapshot dir and add it to the dir's
 * `manifest.json`, which `pixelslash upload` takes as it is. Waits for the page to settle first,
 * shoots with animations disabled and the caret hidden, measures `ignore` in image px (device
 * pixel ratio and full page included) and paints `redact`. Workers share the dir: each write of
 * the manifest is under a lock, and an entry with the same identity is replaced.
 */
export async function snapshot(
  page: Page,
  name: string,
  opts: SnapshotOptions = {},
): Promise<SnapshotEntry> {
  const { browser, viewport } = launched(page);
  await settleCapture(page, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { theme, scale } = await pageState(page);
  const variant = opts.variant ?? `${viewport.width}x${viewport.height}-${theme}`;

  const fullPage = opts.fullPage ?? true;
  const png = await shoot(page, name, opts.redact ?? [], fullPage);
  // The PNG's size from its IHDR chunk, without decoding the image.
  const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  const boxes = await measureIgnore(page, opts.ignore ?? [], fullPage, (selector) =>
    warn(`ignore "${selector}" matched nothing in ${name}`),
  );
  const ignore = toImageRects(boxes, scale, size);

  const dir = opts.dir ?? process.env["PIXELSLASH_SNAPSHOT_DIR"] ?? DEFAULT_DIR;
  const entry: SnapshotEntry = {
    name,
    path: new URL(page.url()).pathname,
    variant: { name: variant, browser: "chromium", viewport, theme },
    tags: opts.tags ?? [],
    diff: {},
    ignore,
    flaky: "review",
    file: `${name}/${variant}.png`,
    fingerprint: await fingerprintOf(browser),
  };
  // The engine's own check: a name or variant that climbs out of the dir is refused.
  const path = pngPath(dir, entry);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, png);
  await locked(dir, () => addEntry(dir, entry));
  return entry;
}

/** The theme the page reports for `prefers-color-scheme`, and its device pixel ratio. */
async function pageState(page: Page): Promise<{ theme: "light" | "dark"; scale: number }> {
  const { dark, scale } = await page.evaluate(() => ({
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    scale: window.devicePixelRatio,
  }));
  return { theme: dark ? "dark" : "light", scale };
}

/** What a baseline must share with a shot to be compared: the image, the browser and the fonts. */
async function fingerprintOf(browser: Browser): Promise<Fingerprint> {
  fonts ??= fontSetHash();
  return {
    image: imageId(process.env),
    browser: `chromium ${browser.version()}`,
    fonts: await fonts,
  };
}

const warn = (message: string) => process.stderr.write(`warning: ${message}\n`);

/** The manifest names one browser, chromium, and a variant needs the viewport it was shot at. */
function launched(page: Page): { browser: Browser; viewport: Size } {
  const browser = page.context().browser();
  if (browser?.browserType().name() !== "chromium")
    throw new Error("pixelslash: snapshot needs a launched chromium; the manifest takes no other");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("pixelslash: snapshot needs a fixed viewport, not viewport: null");
  return { browser, viewport };
}

/** The screenshot, with animations off, the caret hidden and every `redact` match painted over. */
async function shoot(page: Page, name: string, selectors: string[], fullPage: boolean) {
  const mask = await maskLocators(page, selectors, (selector) =>
    warn(`redact "${selector}" matched nothing in ${name}`),
  );
  return page.screenshot({
    fullPage,
    animations: "disabled",
    caret: "hide",
    mask,
    maskColor: MASK_COLOR,
  });
}

/** Run `work` holding the dir's manifest lock: a directory, since `mkdir` is atomic. */
async function locked<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lock = join(dir, ".manifest.lock");
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
      if (Date.now() > until)
        throw new Error(`pixelslash: ${lock} is still held; remove it if no test run is going`, {
          cause: e,
        });
      await Bun.sleep(10);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Add `entry` to the dir's manifest, replacing one with its identity; sorted, so reruns match. */
async function addEntry(dir: string, entry: SnapshotEntry): Promise<void> {
  const path = join(dir, "manifest.json");
  const file = Bun.file(path);
  const manifest: SnapshotManifest = (await file.exists())
    ? JSON.parse(await file.text())
    : { version: 1, snapshots: [] };
  const id = identity(entry);
  const clash = manifest.snapshots.find((e) => identity(e) === id && e.file !== entry.file);
  if (clash)
    throw new Error(
      `pixelslash: ${entry.file} and ${clash.file} are the same shot (${id}); name them apart, or clear ${dir}`,
    );
  const snapshots = [...manifest.snapshots.filter((e) => identity(e) !== id), entry].toSorted(
    (a, b) => identity(a).localeCompare(identity(b)),
  );
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify({ version: 1, snapshots }, null, 2)}\n`);
  await rename(tmp, path);
}
