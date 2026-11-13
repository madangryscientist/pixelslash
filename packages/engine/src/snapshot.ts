import type { Browser, Page } from "playwright";
import type { A11y } from "./a11y-entry.ts";
import type { Metrics } from "./metrics-entry.ts";
import { launchSessionBrowsers } from "./capture-browsers.ts";
import { newShotContext, openPage, pinClock, type ShotProgress } from "./capture-open.ts";
import { attemptFailure, retryOnCrash } from "./crash-retry.ts";
import { loadLibrary, type Composition } from "./composition.ts";
import {
  resolveIgnore,
  type BrowserName,
  type CaptureConfig,
  type FlakyPolicy,
  type Route,
  type Variant,
} from "./config.ts";
import type { DiffOptions, IgnoreRect } from "./diff.ts";
import {
  BARE,
  fcList,
  fontSetHash,
  imageId,
  type Fingerprint,
  type ListFonts,
} from "./fingerprint.ts";
import { MASK_COLOR, toImageRects, type MediaBox } from "./page-areas.ts";
import { mediaWarner } from "./media.ts";
import { joinOrigin } from "./routes.ts";
import { captureInto } from "./capture-into.ts";
import { PreviewPool, pooledAttempt } from "./preview-pool.ts";
import { capture, type Shot } from "./shot-capture.ts";
import { startApp, type StopApp } from "./start.ts";
import { unmatchedTally } from "./unmatched.ts";
import { elapsed, type CaptureSteps, type ShotTiming } from "./timings.ts";
import type { NativeFields } from "./native.ts";
import { storybookRoutes } from "./storybook.ts";

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
  /**
   * This shot's accessibility violations (PS-238). Present only when the config scans; a shot that
   * was not scanned has no field, and nothing is claimed about it. Manifests written before the
   * field existed have none.
   */
  a11y?: A11y;
  /**
   * This shot's layout metrics file (PS-294, `docs/metrics.md`), as a path relative to the manifest's
   * directory, beside the PNG. Present only when the config turns `metrics` on or an import found a
   * `<name>.metrics.json`; manifests written before the field existed have none.
   */
  metrics?: string;
} & NativeFields; // a native shot's platform, device and scale (PS-293); absent on web

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
  /** The capture's wall clock, shots overlapping; the shots' `captureMs` add up to more. */
  captureWallMs?: number;
  /** How many shots ran at once: the concurrency, or fewer when there were fewer shots. */
  captureWorkers?: number;
  /** The shots (`identity`) taken on a pooled preview page; set only when the capture could reuse one (PS-445). */
  reused?: ReadonlySet<string>;
};

export { MASK_COLOR, toImageRects };
export type { MediaBox };
export { captureInto, defaultConcurrency } from "./capture-into.ts";

/** Launch flags that take host-specific rendering choices out of the picture. */
const LAUNCH_ARGS = ["--force-color-profile=srgb", "--font-render-hinting=none"];

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
  a11y?: A11y;
  /** The page's layout metrics (PS-294); absent when not asked for or when the page has no `data-part`. */
  metrics?: Metrics;
  /**
   * Shot on a pooled preview page, not a fresh one (PS-445): its PNG may differ from a fresh
   * page's, so it is kept only where it equals its baseline. Absent on a fresh shot.
   */
  reused?: true;
};

/** One attempt at a shot, in a context of its own. It throws `PageCrash` for a crash, a `CaptureError` for anything else. */
async function attempt(browser: Browser, shot: Shot): Promise<Shoot> {
  const { variant, stabilise, route, url } = shot;
  const setting = performance.now();
  const context = await newShotContext(browser, variant, stabilise, shot.session);
  const progress: ShotProgress = { step: "goto", crashed: false };
  let page: Page | undefined;
  try {
    await pinClock(context, stabilise);
    page = await context.newPage();
    const setupMs = elapsed(setting);
    page.on("crash", () => (progress.crashed = true));
    const opened = await openPage(page, url, route, { timeoutMs: stabilise.timeoutMs, progress });
    progress.step = "screenshot";
    return await capture(page, shot, opened, setupMs);
  } catch (e) {
    throw await attemptFailure(e, url, progress, page);
  } finally {
    await context.close();
  }
}

/** One shot, retried once in a fresh context when its page crashes (PS-332). */
function shoot(browser: Browser, shot: Shot): Promise<Shoot> {
  return retryOnCrash(() => attempt(browser, shot), shot);
}

/**
 * A story on a pooled preview page (PS-445). Anything that goes wrong there (a crash, a throw, a
 * timeout) shoots it again on a fresh page, so a failure is only ever a fresh page's failure.
 */
async function shootPooled(browser: Browser, shot: Shot, pool: PreviewPool): Promise<Shoot> {
  try {
    const { out, switched } = await pooledAttempt(pool, browser, shot, (page, opened, setupMs) =>
      capture(page, shot, opened, setupMs),
    );
    // A story loaded on the slot's page is a fresh page's shot; only a switched one is reused.
    return switched ? { ...out, reused: true } : out;
  } catch {
    return shoot(browser, shot);
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
  /** The fingerprint of a shot taken in `browser`; one of the config's variants' browsers. */
  fingerprintFor: (browser: BrowserName) => Fingerprint;
  /** How long the browsers took to launch, together (PS-195). */
  browserLaunchMs: number;
  /**
   * `scan` asks for the accessibility scan (PS-238); only `captureInto` keeps its result, so a flake
   * re-capture or a dev loop skips it. `reuse` lets a story be shot on a pooled preview page
   * (PS-445); without it, as for every re-capture, the shot is on a fresh page.
   */
  shoot: (
    route: Route,
    variant: Variant,
    scan?: { a11y?: boolean; metrics?: boolean; reuse?: boolean },
  ) => Promise<Shoot>;
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
  const browsers = new Map<BrowserName, Browser>();
  const pool = new PreviewPool();
  const close = async () => {
    unmatched.flush();
    await pool.close();
    await Promise.all([...browsers.values()].map((b) => b.close()));
    await stopApp?.();
  };
  try {
    if (config.start) stopApp = await startApp(config.start);
    const held = await launchSessionBrowsers(config, browsers, LAUNCH_ARGS);
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
    return {
      config,
      routes,
      fingerprintFor: (name) => ({
        image,
        browser: `${name} ${held.of(name).version()}`,
        fonts,
      }),
      browserLaunchMs: held.launchMs,
      shoot: async (route, variant, scan) => {
        const browser = held.of(variant.browser);
        const shot: Shot = {
          url: joinOrigin(route.storybook?.origin ?? config.baseUrl, route.path),
          route,
          variant,
          stabilise: config.stabilise,
          ignore: resolveIgnore(config, route, variant),
          session: held.session,
          library,
          a11y: config.a11y && scan?.a11y === true,
          metrics: config.metrics && scan?.metrics === true,
          warn,
          unmatched,
        };
        const taken =
          scan?.reuse && route.storybook
            ? await shootPooled(browser, shot, pool)
            : await shoot(browser, shot);
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

export { recapture } from "./recapture.ts";
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
    return await captureInto(session, out, undefined, deps.warn ? { warn: deps.warn } : {});
  } finally {
    await session.close();
  }
}
