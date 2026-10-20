import { statfs } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { CaptureError } from "./errors.ts";

const CAPTURE_TIMEOUT_MS = 8_000;

export type CapturePage = (url: string, dest: string, width: number) => Promise<void>;

/**
 * The slice of a browser page the capture settle drives. Playwright's `Page`
 * satisfies it structurally; tests pass a fake so the settle runs without a
 * browser or the DOM lib.
 */
export type SettlePage = {
  evaluate(callback: () => unknown): Promise<unknown>;
  waitForFunction(callback: () => unknown): Promise<unknown>;
  waitForLoadState(state: "networkidle"): Promise<void>;
};

/**
 * Browser globals the settle touches, declared here because the tsconfig has no
 * DOM lib. Type-only: nothing is emitted, and the callbacks below run in the page
 * (Playwright serializes their source), where these are the real globals.
 */
declare const document: {
  fonts: { ready: Promise<unknown> };
  images: ArrayLike<{ complete: boolean; naturalWidth: number }>;
};
declare function requestAnimationFrame(callback: () => void): number;
declare const window: {
  pixelslashRaf?: (callback: () => void) => number;
  requestAnimationFrame(callback: () => void): number;
};

/**
 * Init script that keeps the browser's own `requestAnimationFrame` where the settle can reach it.
 * Added before a fake clock is installed: the clock replaces the page's rAF with one that only
 * fires when the clock is advanced, and the settle must not advance it (that would run page timers).
 */
export function keepNativeRaf(): void {
  window.pixelslashRaf = window.requestAnimationFrame.bind(window);
}

const twoFrames = () =>
  new Promise<void>((resolve) => {
    const raf = window.pixelslashRaf ?? requestAnimationFrame;
    raf(() => raf(() => resolve()));
  });

/**
 * Wait for a page to settle before screenshotting: web fonts, every image, a
 * short network-idle window, then two animation frames. Bounded by `timeoutMs`
 * (default CAPTURE_TIMEOUT_MS) so a page whose fonts never load does not hang
 * the capture past it.
 *
 * The frames are the browser's real ones even when page timers are frozen (see
 * `keepNativeRaf`), so the settle never gives a frozen page any timer time.
 */
export function settleCapture(page: SettlePage, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<void> {
  const steps = (async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
    );
    await page.waitForLoadState("networkidle");
    await page.evaluate(twoFrames);
  })();
  return withTimeout(steps, timeoutMs, `capture settle exceeded ${timeoutMs}ms`);
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CaptureError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/** Launch headless Chromium, using /dev/shm for shared memory when it has room (see `roomyShm`). */
export async function launchChromium(args: string[] = []): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args,
    ...((await roomyShm()) ? { ignoreDefaultArgs: ["--disable-dev-shm-usage"] } : {}),
  });
}

export function launchBrowser(): Promise<Browser> {
  return launchChromium();
}

async function shot(browser: Browser, url: string, dest: string, width: number): Promise<void> {
  const page = await browser.newPage({ viewport: { width, height: 720 } });
  page.setDefaultNavigationTimeout(CAPTURE_TIMEOUT_MS);
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!resp) throw new CaptureError(`capture failed for ${url}: no response`);
    if (resp.status() >= 400)
      throw new CaptureError(`capture failed for ${url}: HTTP ${resp.status()}`);
    await settleCapture(page);
    await page.screenshot({ path: dest, fullPage: true });
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new CaptureError(`capture failed for ${url}: ${msg}`);
  } finally {
    await page.close();
  }
}

type ShotPair = { liveUrl: string; localUrl: string; liveDest: string; localDest: string };

/** Capture Main then Branch, through `capture` when given, else one fresh browser. */
export async function capturePair(
  pair: ShotPair,
  width: number,
  capture?: CapturePage,
): Promise<void> {
  if (capture) {
    await capture(pair.liveUrl, pair.liveDest, width);
    await capture(pair.localUrl, pair.localDest, width);
    return;
  }
  const browser = await launchBrowser();
  try {
    await shotPair(browser, pair, width);
  } finally {
    await browser.close();
  }
}

export async function shotPair(browser: Browser, pair: ShotPair, width: number): Promise<void> {
  await shot(browser, pair.liveUrl, pair.liveDest, width);
  await shot(browser, pair.localUrl, pair.localDest, width);
}
