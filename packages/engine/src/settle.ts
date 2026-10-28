import { CaptureError } from "./errors.ts";
import { elapsed, type SettleSteps } from "./timings.ts";

// The page settle, apart from the launchers in capture.ts so the Playwright helper's Node bundle takes
// it without `import "playwright"` (PS-237).

export const CAPTURE_TIMEOUT_MS = 8_000;

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
 * the capture past it. Resolves to how long each condition took.
 *
 * The frames are the browser's real ones even when page timers are frozen (see
 * `keepNativeRaf`), so the settle never gives a frozen page any timer time.
 */
export function settleCapture(
  page: SettlePage,
  timeoutMs = CAPTURE_TIMEOUT_MS,
): Promise<SettleSteps> {
  const steps = (async () => {
    const fontsMs = await timedMs(() => page.evaluate(() => document.fonts.ready));
    const imagesMs = await timedMs(() =>
      page.waitForFunction(() =>
        Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
      ),
    );
    const networkIdleMs = await timedMs(() => page.waitForLoadState("networkidle"));
    const framesMs = await timedMs(() => page.evaluate(twoFrames));
    return { fontsMs, imagesMs, networkIdleMs, framesMs };
  })();
  return withTimeout(steps, timeoutMs, `capture settle exceeded ${timeoutMs}ms`);
}

async function timedMs(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await fn();
  return elapsed(started);
}

export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
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
