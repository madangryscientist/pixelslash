import type { Browser, BrowserContext, Page } from "playwright";
import { PNG } from "pngjs";
import { keepNativeRaf, launchChromium, settleCapture } from "./capture.ts";
import {
  loadLibrary,
  measureComposition,
  type Composition,
  type CompositionLibrary,
} from "./composition.ts";
import {
  resolveIgnore,
  type CaptureConfig,
  type FlakyPolicy,
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
import {
  maskLocators,
  measureIgnore,
  measureMedia,
  toImageRects,
  unexcluded,
  type MediaBox,
} from "./page-areas.ts";
import { mediaWarner } from "./media.ts";
import { joinOrigin } from "./routes.ts";
import { captureInto } from "./capture-into.ts";
import { signIn, type Session } from "./setup.ts";
import { startApp, type StopApp } from "./start.ts";
import { unmatchedTally, type UnmatchedTally } from "./unmatched.ts";
import { elapsed, type CaptureSteps, type SettleSteps, type ShotTiming } from "./timings.ts";
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
  /**
   * What the server does if this shot's captures disagree (ob 1737), resolved from the config.
   * Manifests written before this field existed have none, read as `"review"`.
   */
  flaky: FlakyPolicy;
  /** Relative to the manifest's directory. */
  file: string;
  fingerprint: Fingerprint;
  /**
   * A composition-only project's findings for this shot (ob 1850): what is styled outside the
   * library, and the declared special cases. Absent for any other project, and in manifests
   * written before the field existed.
   */
  composition?: Composition;
};

/** `manifest.json` in the snapshot dir. No timestamps: two runs of the same build write the same bytes. */
export type SnapshotManifest = { version: 1; snapshots: SnapshotEntry[] };

export type SnapshotDeps = {
  env?: NodeJS.ProcessEnv;
  listFonts?: ListFonts;
  warn?: (message: string) => void;
};

export type SnapshotResult = {
  manifest: SnapshotManifest;
  manifestPath: string;
  /** How long each shot took to capture (load, settle, screenshot), in capture order. Not in the manifest: that stays byte-for-byte reproducible. */
  shots: ShotTiming[];
  /** `gaps.html` beside the manifest, for a composition-only project. */
  gapsPath?: string;
  /** The media no ignore area covers, by shot (`identity`), for the shots that have any (PS-230). Not in the manifest. */
  media: Record<string, MediaBox[]>;
};

export { toImageRects };
export type { MediaBox };
export { captureInto } from "./capture-into.ts";

/** Launch flags that take host-specific rendering choices out of the picture. */
const LAUNCH_ARGS = ["--force-color-profile=srgb", "--font-render-hinting=none"];

/**
 * Resolve ignore areas on the live page to image-px boxes: every match of every selector, every
 * `[data-pixelslash-ignore]` element, and the fixed rectangles. Nothing is painted. A selector that
 * matches nothing is tallied for the run, like a mask's.
 */
async function resolveIgnoreBoxes(
  page: Page,
  areas: Ignore[],
  shot: Pick<Shot, "stabilise" | "unmatched">,
  image: { width: number; height: number },
): Promise<IgnoreRect[]> {
  const selectors = areas.filter((a) => typeof a === "string");
  const misses = shot.unmatched.checked("ignore", selectors);
  const boxes = await measureIgnore(page, selectors, true, misses);
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

type Opened = { navigateMs: number; settleMs: number; settle: SettleSteps };

/** Load the page and wait for it to settle; returns how long each took, the page's own time. */
async function open(page: Page, url: string, route: Route, timeoutMs: number): Promise<Opened> {
  page.setDefaultNavigationTimeout(timeoutMs);
  const loading = performance.now();
  const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
  const settling = performance.now();
  if (!resp) throw new CaptureError(`capture failed for ${url}: no response`);
  if (resp.status() >= 400)
    throw new CaptureError(`capture failed for ${url}: HTTP ${resp.status()}`);
  // A story's own render signal and the generic settle share one budget.
  const started = Date.now();
  if (route.storybook) await awaitStory(page, route.name, timeoutMs);
  const settle = await settleCapture(page, Math.max(1, timeoutMs - (Date.now() - started)));
  return {
    navigateMs: settling - loading,
    settleMs: performance.now() - settling,
    settle,
  };
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
  /** The library a composition-only project is measured against; undefined for any other project. */
  library: CompositionLibrary | undefined;
  warn: (m: string) => void;
  unmatched: UnmatchedTally;
};

/**
 * One capture of a shot: its PNG, its ignore areas in image px, the page's load + settle time, and
 * (composition-only projects) what is styled outside the library.
 */
export type Shoot = {
  png: Buffer;
  ignore: IgnoreRect[];
  /** Navigate and settle together, unrounded: `pixelslash dev` adds these up. */
  loadMs?: number;
  /** Navigate, settle and screenshot apart (PS-195). */
  steps?: CaptureSteps;
  /**
   * The `<video>` and `<audio>` on the page that no ignore area covers, in CSS px: media renders
   * unreliably, so each is a region to exclude (PS-230). Measured after the settle; nothing is done
   * to the media, and the PNG and the diff are as they were.
   */
  media: MediaBox[];
  composition?: Composition;
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
    const opened = await open(page, url, route, stabilise.timeoutMs);
    const selectors = route.masks.filter((m) => typeof m === "string");
    const locators = await maskLocators(page, selectors, shot.unmatched.checked("mask", selectors));
    const shooting = performance.now();
    const png = await page.screenshot({
      fullPage: true,
      animations: stabilise.animations ? "disabled" : "allow",
      caret: stabilise.caret ? "hide" : "initial",
      mask: locators,
      maskColor: MASK_COLOR,
    });
    const steps: CaptureSteps = {
      navigateMs: Math.round(opened.navigateMs),
      settleMs: Math.round(opened.settleMs),
      screenshotMs: elapsed(shooting),
      settle: opened.settle,
    };
    // The PNG's size from its IHDR chunk, without decoding the image.
    const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    const ignore = await resolveIgnoreBoxes(page, shot.ignore, shot, size);
    const media = unexcluded(await measureMedia(page), ignore, stabilise.deviceScaleFactor, size);
    const composition =
      shot.library &&
      (await measureComposition(page, shot.library, {
        scale: stabilise.deviceScaleFactor,
        image: size,
        warn: shot.warn,
      }));
    return {
      png: paintRects(
        png,
        route.masks.filter((m) => typeof m !== "string"),
        stabilise.deviceScaleFactor,
      ),
      ignore,
      media,
      loadMs: opened.navigateMs + opened.settleMs,
      steps,
      ...(composition && { composition }),
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

/**
 * A browser on the config's app, held open: the app started (when the config starts one), signed
 * in, the routes read. `captureInto` shoots every route through it, and an upload re-captures a
 * shot through it (ob 1737), with the same route, variant and stabilisation as the first time.
 */
export type CaptureSession = {
  config: CaptureConfig;
  routes: Route[];
  fingerprint: Fingerprint;
  /** How long the browser took to launch (PS-195). */
  browserLaunchMs: number;
  shoot: (route: Route, variant: Variant) => Promise<Shoot>;
  /** Print the selectors that matched nothing since the last flush (PS-241); `close` does too. */
  flush: () => void;
  close: () => Promise<void>;
};

/** Start the app, launch the browser, sign in and read the routes. The caller closes it. */
export async function openCaptureSession(
  config: CaptureConfig,
  deps: SnapshotDeps = {},
): Promise<CaptureSession> {
  const warn = deps.warn ?? (() => {});
  const warnMedia = mediaWarner(warn);
  const unmatched = unmatchedTally(warn);
  const image = imageId(deps.env ?? process.env);
  if (image === BARE)
    warn(
      "warning: capturing outside the pinned PixelSlash image; local fonts skew rendering. Fingerprint recorded as bare.",
    );
  const fonts = await fontSetHash(deps.listFonts ?? fcList);
  // Read before the app starts, so a library that is not installed fails first.
  const library = config.composition && (await loadLibrary(config.composition));
  let stopApp: StopApp | undefined;
  let browser: Browser | undefined;
  const close = async () => {
    unmatched.flush();
    await browser?.close();
    await stopApp?.();
  };
  try {
    if (config.start) stopApp = await startApp(config.start);
    const launching = performance.now();
    const launched = await launchChromium(LAUNCH_ARGS);
    const browserLaunchMs = elapsed(launching);
    browser = launched;
    const fingerprint: Fingerprint = { image, browser: `chromium ${launched.version()}`, fonts };
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
    const session = await signIn(launched, config);
    return {
      config,
      routes,
      fingerprint,
      browserLaunchMs,
      shoot: async (route, variant) => {
        const taken = await shoot(launched, {
          url: joinOrigin(route.storybook?.origin ?? config.baseUrl, route.path),
          route,
          variant,
          stabilise: config.stabilise,
          ignore: resolveIgnore(config, route, variant),
          session,
          library,
          warn,
          unmatched,
        });
        warnMedia(route, variant, taken.media);
        return taken;
      },
      flush: () => unmatched.flush(),
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The shot a manifest entry names, again; `undefined` when the config has no such route or variant. */
export function recapture(
  session: CaptureSession,
  entry: Pick<SnapshotEntry, "name" | "variant">,
): Promise<Shoot | undefined> {
  const route = session.routes.find((r) => r.name === entry.name);
  const variant = session.config.variants.find((v) => v.name === entry.variant.name);
  return route && variant ? session.shoot(route, variant) : Promise.resolve(undefined);
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
  const session = await openCaptureSession(config, deps);
  try {
    return await captureInto(session, out);
  } finally {
    await session.close();
  }
}
