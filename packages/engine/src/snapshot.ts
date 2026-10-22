import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { PNG } from "pngjs";
import { keepNativeRaf, launchChromium, settleCapture } from "./capture.ts";
import {
  resolveDiff,
  resolveIgnore,
  type CaptureConfig,
  type Ignore,
  type MaskRect,
  type Route,
  type Stabilise,
  type Variant,
} from "./config.ts";
import type { DiffOptions, IgnoreRect } from "./diff.ts";
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
import { signIn, type Session } from "./setup.ts";
import { startApp, type StopApp } from "./start.ts";
import { awaitStory, storybookRoutes } from "./storybook.ts";

/** Masked regions are painted this colour, by Playwright for selectors and by us for rectangles. */
export const MASK_COLOR = "#FF00FF";
const MASK_RGBA = [255, 0, 255, 255] as const;

/** One snapshot in the manifest: what it is (name + variant + tags), what made it, and its PNG. */
export type SnapshotEntry = {
  name: string;
  path: string;
  variant: Variant;
  tags: string[];
  /**
   * The diff options this snapshot is compared with, resolved from the config (variant > route >
   * project). Only keys someone set; absent keys take the engine default at diff time. Manifests
   * written before this field existed have none, read as `{}`.
   */
  diff: DiffOptions;
  /**
   * Areas the diff skips, in image px (full page, already scaled by the device scale factor and
   * clipped to the image). Selectors in the config are resolved to these boxes at capture time.
   * Real pixels stay in the PNG. Manifests written before this field existed have none, read as `[]`.
   */
  ignore: IgnoreRect[];
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

/** The attribute that marks an element as an ignore area without a config entry. */
const IGNORE_ATTRIBUTE = "data-pixelslash-ignore";

/**
 * Browser globals the box measure touches (the tsconfig has no DOM lib). Type-only: the callback in
 * `boxesOf` is serialized and runs in the page, where these are the real globals.
 */
declare const window: { scrollX: number; scrollY: number };
type Measured = {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};

/** Each element's box in full-page CSS px (viewport box plus the scroll offset). Runs in the page. */
function boxesOf(elements: Measured[]): MaskRect[] {
  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  });
}

/** PNG dimensions from the IHDR chunk, without decoding the image. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * CSS-px boxes to image px: scaled by `scale`, grown outward to whole pixels, clipped to the image.
 * Boxes that end up empty (zero-size elements, boxes wholly off the image) are dropped.
 */
export function toImageRects(
  boxes: { x: number; y: number; width: number; height: number }[],
  scale: number,
  image: { width: number; height: number },
): IgnoreRect[] {
  const out: IgnoreRect[] = [];
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * scale));
    const y0 = Math.max(0, Math.floor(b.y * scale));
    const x1 = Math.min(image.width, Math.ceil((b.x + b.width) * scale));
    const y1 = Math.min(image.height, Math.ceil((b.y + b.height) * scale));
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}

/**
 * Resolve ignore areas on the live page to image-px boxes: every match of every selector, every
 * `[data-pixelslash-ignore]` element, and the fixed rectangles. Nothing is painted. A selector that
 * matches nothing warns, like a mask does.
 */
async function resolveIgnoreBoxes(
  page: Page,
  areas: Ignore[],
  shot: Pick<Shot, "route" | "stabilise" | "warn">,
  image: { width: number; height: number },
): Promise<IgnoreRect[]> {
  const boxes: MaskRect[] = [];
  const selectors = [...areas.filter((a) => typeof a === "string"), `[${IGNORE_ATTRIBUTE}]`];
  for (const selector of selectors) {
    const loc = page.locator(selector);
    if ((await loc.count()) === 0) {
      if (!selector.startsWith(`[${IGNORE_ATTRIBUTE}`))
        shot.warn(`warning: ignore "${selector}" matched nothing on ${shot.route.path}`);
      continue;
    }
    boxes.push(...(await loc.evaluateAll(boxesOf)));
  }
  boxes.push(...areas.filter((a) => typeof a !== "string"));
  return toImageRects(boxes, shot.stabilise.deviceScaleFactor, image);
}

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

async function open(page: Page, url: string, route: Route, timeoutMs: number): Promise<void> {
  page.setDefaultNavigationTimeout(timeoutMs);
  const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!resp) throw new CaptureError(`capture failed for ${url}: no response`);
  if (resp.status() >= 400)
    throw new CaptureError(`capture failed for ${url}: HTTP ${resp.status()}`);
  // A story's own render signal and the generic settle share one budget.
  const started = Date.now();
  if (route.storybook) await awaitStory(page, route.name, timeoutMs);
  await settleCapture(page, Math.max(1, timeoutMs - (Date.now() - started)));
}

type Shot = {
  url: string;
  route: Route;
  variant: Variant;
  stabilise: Stabilise;
  /** Ignore areas to resolve at screenshot time; the pixels are left as they are. */
  ignore: Ignore[];
  /** What the config's `setup` left signed in, if it has one. */
  session: Session | undefined;
  warn: (m: string) => void;
};

type Shoot = { png: Buffer; ignore: IgnoreRect[] };

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

async function shoot(browser: Browser, shot: Shot): Promise<Shoot> {
  const { variant, stabilise, route, url } = shot;
  const context = await browser.newContext({
    viewport: variant.viewport,
    deviceScaleFactor: stabilise.deviceScaleFactor,
    colorScheme: variant.theme,
    ...(shot.session && { storageState: shot.session }),
  });
  try {
    await pinClock(context, stabilise);
    const page = await context.newPage();
    await open(page, url, route, stabilise.timeoutMs);
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
    const ignore = await resolveIgnoreBoxes(page, shot.ignore, shot, pngSize(png));
    return {
      png: paintRects(
        png,
        route.masks.filter((m) => typeof m !== "string"),
        stabilise.deviceScaleFactor,
      ),
      ignore,
    };
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    throw new CaptureError(
      `capture failed for ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await context.close();
  }
}

/** The page shots a config asks for, every route (hand-written, then Storybook's) under every variant, sharing one browser. */
async function shootAll(
  config: CaptureConfig,
  routes: Route[],
  out: string,
  ctx: {
    fingerprint: Fingerprint;
    browser: Browser;
    session: Session | undefined;
    warn: (m: string) => void;
  },
): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  for (const variant of config.variants) {
    for (const route of routes) {
      const file = `${route.name}/${variant.name}.png`;
      const url = joinOrigin(route.storybook?.origin ?? config.baseUrl, route.path);
      const { png, ignore } = await shoot(ctx.browser, {
        url,
        route,
        variant,
        stabilise: config.stabilise,
        ignore: resolveIgnore(config, route, variant),
        session: ctx.session,
        warn: ctx.warn,
      });
      await mkdir(join(out, route.name), { recursive: true });
      await Bun.write(join(out, file), png);
      entries.push({
        name: route.name,
        path: route.path,
        variant,
        tags: route.tags,
        diff: resolveDiff(config, route, variant),
        ignore,
        file,
        fingerprint: ctx.fingerprint,
      });
    }
  }
  return entries;
}

/**
 * Capture every route × variant in `config` into `out` and write `out/manifest.json`.
 * Starts the app first when the config has a start command, and stops it after; runs the
 * config's `setup` once the app is up, and shoots every route with the session it left.
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
    // The app is up now, so the Storybook's index can be read.
    const routes = config.storybook
      ? [
          ...config.routes,
          ...(await storybookRoutes(
            config.storybook,
            config.routes.map((r) => r.name),
          )),
        ]
      : config.routes;
    const session = await signIn(browser, config);
    const snapshots = await shootAll(config, routes, out, { fingerprint, browser, session, warn });
    const manifest: SnapshotManifest = { version: 1, snapshots };
    const manifestPath = join(out, "manifest.json");
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, manifestPath };
  } finally {
    await browser?.close();
    await stopApp?.();
  }
}
