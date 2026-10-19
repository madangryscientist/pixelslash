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

/**
 * Wait for a page to settle before screenshotting: web fonts, every image, a
 * short network-idle window, then two animation frames. Bounded by `timeoutMs`
 * (default CAPTURE_TIMEOUT_MS) so a page whose fonts never load does not hang
 * the capture past it.
 */
export function settleCapture(page: SettlePage, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<void> {
  const steps = (async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
    );
    await page.waitForLoadState("networkidle");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
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

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
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
