import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { PNG } from "pngjs";
import { keepNativeRaf, launchChromium, settleCapture } from "./capture.ts";
import type { CaptureConfig, MaskRect, Route, Stabilise, Variant } from "./config.ts";
import { CaptureError } from "./errors.ts";
import {
  BARE,
  fcList,
  fontSetHash,
  imageId,
  type Fingerprint,
  type ListFonts,
} from "./fingerprint.ts";
import { joinOrigin } from "./routes.ts";
import { startApp, type StopApp } from "./start.ts";

/** Masked regions are painted this colour, by Playwright for selectors and by us for rectangles. */
export const MASK_COLOR = "#FF00FF";
const MASK_RGBA = [255, 0, 255, 255] as const;

/** One snapshot in the manifest: what it is (name + variant + tags), what made it, and its PNG. */
export type SnapshotEntry = {
  name: string;
  path: string;
  variant: Variant;
  tags: string[];
  /** Relative to the manifest's directory. */
  file: string;
  fingerprint: Fingerprint;
};

/** `manifest.json` in the snapshot dir. No timestamps: two runs of the same build write the same bytes. */
export type SnapshotManifest = { version: 1; snapshots: SnapshotEntry[] };

export type SnapshotDeps = {
  env?: NodeJS.ProcessEnv;
  listFonts?: ListFonts;
  warn?: (message: string) => void;
};

export type SnapshotResult = { manifest: SnapshotManifest; manifestPath: string };

/** Launch flags that take host-specific rendering choices out of the picture. */
const LAUNCH_ARGS = ["--force-color-profile=srgb", "--font-render-hinting=none"];

/** Paint each rectangle (CSS px, scaled by `scale` to image px, clipped to the image) in MASK_COLOR. */
export function paintRects(png: Buffer, rects: MaskRect[], scale: number): Buffer {
  if (rects.length === 0) return png;
  const img = PNG.sync.read(png);
  for (const r of rects) {
    const x1 = Math.min(img.width, (r.x + r.width) * scale);
    const y1 = Math.min(img.height, (r.y + r.height) * scale);
    for (let y = r.y * scale; y < y1; y++) {
      for (let x = r.x * scale; x < x1; x++) img.data.set(MASK_RGBA, (y * img.width + x) << 2);
    }
  }
  return PNG.sync.write(img);
}

async function open(page: Page, url: string, timeoutMs: number): Promise<void> {
  page.setDefaultNavigationTimeout(timeoutMs);
  const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!resp) throw new CaptureError(`capture failed for ${url}: no response`);
  if (resp.status() >= 400)
    throw new CaptureError(`capture failed for ${url}: HTTP ${resp.status()}`);
  await settleCapture(page, timeoutMs);
}

type Shot = {
  url: string;
  route: Route;
  variant: Variant;
  stabilise: Stabilise;
  warn: (m: string) => void;
};

/**
 * Pin the page clock before navigation. With `timers` it is fake timers installed and paused at the
 * instant, so nothing the page schedules fires on its own, and the clock is never advanced after
 * (the settle uses the browser's own frames; see `keepNativeRaf`). Without, only Date is fixed and
 * timers run. A real clock is left alone.
 */
async function pinClock(context: BrowserContext, { clock, timers }: Stabilise): Promise<void> {
  if (clock === false) return;
  if (!timers) return context.clock.setFixedTime(clock);
  await context.addInitScript(keepNativeRaf);
  await context.clock.install({ time: clock });
  await context.clock.pauseAt(clock);
}

async function shoot(browser: Browser, shot: Shot): Promise<Buffer> {
  const { variant, stabilise, route, url } = shot;
  const context = await browser.newContext({
    viewport: variant.viewport,
    deviceScaleFactor: stabilise.deviceScaleFactor,
    colorScheme: variant.theme,
  });
  try {
    await pinClock(context, stabilise);
    const page = await context.newPage();
    await open(page, url, stabilise.timeoutMs);
    const selectors = route.masks.filter((m) => typeof m === "string");
    const locators = selectors.map((s) => page.locator(s));
    for (const [i, loc] of locators.entries()) {
      if ((await loc.count()) === 0)
        shot.warn(`warning: mask "${selectors[i]}" matched nothing on ${route.path}`);
    }
    const png = await page.screenshot({
      fullPage: true,
      animations: stabilise.animations ? "disabled" : "allow",
      caret: stabilise.caret ? "hide" : "initial",
      mask: locators,
      maskColor: MASK_COLOR,
    });
    return paintRects(
      png,
      route.masks.filter((m) => typeof m !== "string"),
      stabilise.deviceScaleFactor,
    );
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    throw new CaptureError(
      `capture failed for ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await context.close();
  }
}

/** The page shots a config asks for, every route under every variant, sharing one browser. */
async function shootAll(
  config: CaptureConfig,
  out: string,
  ctx: { fingerprint: Fingerprint; browser: Browser; warn: (m: string) => void },
): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  for (const variant of config.variants) {
    for (const route of config.routes) {
      const file = `${route.name}/${variant.name}.png`;
      const url = joinOrigin(config.baseUrl, route.path);
      const png = await shoot(ctx.browser, {
        url,
        route,
        variant,
        stabilise: config.stabilise,
        warn: ctx.warn,
      });
      await mkdir(join(out, route.name), { recursive: true });
      await Bun.write(join(out, file), png);
      entries.push({
        name: route.name,
        path: route.path,
        variant,
        tags: route.tags,
        file,
        fingerprint: ctx.fingerprint,
      });
    }
  }
  return entries;
}

/**
 * Capture every route × variant in `config` into `out` and write `out/manifest.json`.
 * Starts the app first when the config has a start command, and stops it after.
 * Outside the pinned image this still works, warns, and records `image: "bare"`.
 */
export async function captureSnapshots(
  config: CaptureConfig,
  out: string,
  deps: SnapshotDeps = {},
): Promise<SnapshotResult> {
  const warn = deps.warn ?? (() => {});
  const image = imageId(deps.env ?? process.env);
  if (image === BARE)
    warn(
      "warning: capturing outside the pinned PixelSlash image; local fonts skew rendering. Fingerprint recorded as bare.",
    );
  const fonts = await fontSetHash(deps.listFonts ?? fcList);
  let stopApp: StopApp | undefined;
  let browser: Browser | undefined;
  try {
    if (config.start) stopApp = await startApp(config.start);
    browser = await launchChromium(LAUNCH_ARGS);
    const fingerprint: Fingerprint = { image, browser: `chromium ${browser.version()}`, fonts };
    await mkdir(out, { recursive: true });
    const snapshots = await shootAll(config, out, { fingerprint, browser, warn });
    const manifest: SnapshotManifest = { version: 1, snapshots };
    const manifestPath = join(out, "manifest.json");
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, manifestPath };
  } finally {
    await browser?.close();
    await stopApp?.();
  }
}
