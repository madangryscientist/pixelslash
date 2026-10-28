import { statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit, type Browser } from "playwright";
import type { BrowserName } from "./config.ts";
import { CaptureError } from "./errors.ts";
import { CAPTURE_TIMEOUT_MS, settleCapture } from "./settle.ts";
import { addSteps, elapsed, type CaptureSteps } from "./timings.ts";

export { keepNativeRaf, settleCapture, withTimeout, type SettlePage } from "./settle.ts";

/** The browser `capture` launches by default: what `pixelslash install-browser` installs. */
export const CAPTURE_BROWSER = "chromium-headless-shell";

/** What `playwright install` calls each browser a variant can name. */
export const INSTALL_NAMES: Record<BrowserName, string> = {
  chromium: CAPTURE_BROWSER,
  firefox: "firefox",
  webkit: "webkit",
};

/** The `playwright` CLI of the Playwright this package captures with, so the browser it installs is the one it launches. */
export function playwrightCli(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("playwright/package.json"))), "cli.js");
}

export type CapturePage = (url: string, dest: string, width: number) => Promise<void>;

const SHM_DIR = "/dev/shm";
const SHM_MIN_BYTES = 1024 * 1024 * 1024;

/**
 * Whether /dev/shm has room for Chromium's shared memory.
 * Playwright launches Chromium with `--disable-dev-shm-usage`, which moves that
 * memory into the temp dir. On a host whose /tmp is a quota'd or busy tmpfs the GPU
 * process then dies mid-screenshot ("Unable to capture screenshot"), a different
 * shot each run once several browsers run at once. That flag exists for Docker's
 * 64 MB /dev/shm, so it is dropped only when /dev/shm is big enough.
 */
export async function roomyShm(): Promise<boolean> {
  try {
    const { bavail, bsize } = await statfs(SHM_DIR);
    return bavail * bsize >= SHM_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Launch headless Chromium, using /dev/shm for shared memory when it has room (see `roomyShm`).
 * Playwright's own SIGTERM and SIGHUP handlers are off: they close the browser and leave the
 * process running, so a `pixelslash dev` sent SIGTERM lived on, holding its lock with a dead
 * browser, and the next `dev` attached to it and failed its first run (ob 1761). Without them the
 * signal ends the process (or `dev`'s handler does), and the browser goes with its pipe.
 */
export async function launchChromium(args: string[] = []): Promise<Browser> {
  return chromium.launch({
    headless: true,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args,
    ...((await roomyShm()) ? { ignoreDefaultArgs: ["--disable-dev-shm-usage"] } : {}),
  });
}

/**
 * Launch headless Firefox or WebKit. Neither takes Chromium's flags or its /dev/shm choice; the
 * signal handlers are off for the reason `launchChromium` gives.
 */
function launchOther(name: Exclude<BrowserName, "chromium">): Promise<Browser> {
  const type = name === "firefox" ? firefox : webkit;
  return type.launch({ headless: true, handleSIGTERM: false, handleSIGHUP: false });
}

/** The browser a variant names, launched; `chromiumArgs` apply to Chromium only. */
export function launchBrowser(
  name: BrowserName = "chromium",
  chromiumArgs: string[] = [],
): Promise<Browser> {
  return name === "chromium" ? launchChromium(chromiumArgs) : launchOther(name);
}

async function shot(
  browser: Browser,
  url: string,
  dest: string,
  width: number,
): Promise<CaptureSteps> {
  const page = await browser.newPage({ viewport: { width, height: 720 } });
  page.setDefaultNavigationTimeout(CAPTURE_TIMEOUT_MS);
  try {
    const navigating = performance.now();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    const navigateMs = elapsed(navigating);
    if (!resp) throw new CaptureError(`capture failed for ${url}: no response`);
    if (resp.status() >= 400)
      throw new CaptureError(`capture failed for ${url}: HTTP ${resp.status()}`);
    const settling = performance.now();
    const settle = await settleCapture(page);
    const settleMs = elapsed(settling);
    const shooting = performance.now();
    await page.screenshot({ path: dest, fullPage: true });
    return { navigateMs, settleMs, screenshotMs: elapsed(shooting), settle };
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new CaptureError(`capture failed for ${url}: ${msg}`);
  } finally {
    await page.close();
  }
}

type ShotPair = { liveUrl: string; localUrl: string; liveDest: string; localDest: string };

/** A pair's capture steps, both shots added up, and the browser launch when this pair launched one. */
export type PairSteps = { steps: CaptureSteps; browserLaunchMs?: number };

/**
 * Capture Main and Branch, through `capture` when given (one after the other; it reports no steps),
 * else both at once in one fresh browser.
 */
export async function capturePair(
  pair: ShotPair,
  width: number,
  capture?: CapturePage,
  name?: BrowserName,
): Promise<PairSteps | undefined> {
  if (capture) {
    await capture(pair.liveUrl, pair.liveDest, width);
    await capture(pair.localUrl, pair.localDest, width);
    return undefined;
  }
  const launching = performance.now();
  const browser = await launchBrowser(name);
  const browserLaunchMs = elapsed(launching);
  try {
    return { steps: await shotPair(browser, pair, width), browserLaunchMs };
  } finally {
    await browser.close();
  }
}

export async function shotPair(
  browser: Browser,
  pair: ShotPair,
  width: number,
): Promise<CaptureSteps> {
  // Both pages at once (PS-195): each waits for its own settle, and the waits overlap.
  // Both settle before either error is thrown, so the caller never closes the browser under a page
  // still shooting, and Main's error wins as it did when Main was shot first.
  const [live, local] = await Promise.allSettled([
    shot(browser, pair.liveUrl, pair.liveDest, width),
    shot(browser, pair.localUrl, pair.localDest, width),
  ]);
  if (live.status === "rejected") throw live.reason;
  if (local.status === "rejected") throw local.reason;
  return addSteps(live.value, local.value);
}
