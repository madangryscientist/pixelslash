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
 * A page's requests that have started and not finished, counted from the moment it was made.
 * `idle()` resolves when the count is zero. A websocket is not a request that finishes (Playwright
 * reports it as its own `websocket` event), so it never holds the count.
 */
export type Inflight = {
  count(): number;
  /** How many requests have started, ever: a request that began and ended between two reads still shows. */
  started(): number;
  idle(): Promise<void>;
};

/** The slice of a Playwright page `trackInflight` listens on. */
export type InflightPage = {
  on(event: "request" | "requestfinished" | "requestfailed", listener: () => void): unknown;
};

/**
 * Count a page's in-flight requests: plus one on `request`, minus one on `requestfinished` or
 * `requestfailed`. Call it when the page is made, before `goto`, so the requests the navigation
 * starts are counted; the settle waits on it in place of Playwright's fixed `networkidle` window.
 */
export function trackInflight(page: InflightPage): Inflight {
  let count = 0;
  let started = 0;
  let waiters: Array<() => void> = [];
  const finish = () => {
    count = Math.max(0, count - 1);
    if (count === 0) {
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
    }
  };
  page.on("request", () => {
    count += 1;
    started += 1;
  });
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  return {
    count: () => count,
    started: () => started,
    idle: () =>
      count === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve);
          }),
  };
}

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
 * Wait for a page to settle before screenshotting: web fonts, every image, the network, then two
 * animation frames. With `inflight` (made by `trackInflight` before navigation) the network wait is
 * no request in flight: after the frames the tracker is read again, and a request that started
 * meanwhile (even one that already finished) makes the settle wait and run the frames again. Without it the wait is Playwright's
 * `networkidle` (500ms with no connection), which is all a page the caller already navigated
 * allows. Bounded by `timeoutMs`
 * (default CAPTURE_TIMEOUT_MS) so a page whose fonts never load does not hang
 * the capture past it. Resolves to how long each condition took.
 *
 * The frames are the browser's real ones even when page timers are frozen (see
 * `keepNativeRaf`), so the settle never gives a frozen page any timer time.
 */
export function settleCapture(
  page: SettlePage,
  timeoutMs = CAPTURE_TIMEOUT_MS,
  inflight?: Inflight,
): Promise<SettleSteps> {
  const steps = (async () => {
    const fontsMs = await timedMs(() => page.evaluate(() => document.fonts.ready));
    const imagesMs = await timedMs(() =>
      page.waitForFunction(() =>
        Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
      ),
    );
    if (!inflight) {
      const networkIdleMs = await timedMs(() => page.waitForLoadState("networkidle"));
      const framesMs = await timedMs(() => page.evaluate(twoFrames));
      return { fontsMs, imagesMs, networkIdleMs, framesMs };
    }
    let networkIdleMs = 0;
    let framesMs = 0;
    let seen: number;
    do {
      seen = inflight.started();
      networkIdleMs += await timedMs(() => inflight.idle());
      framesMs += await timedMs(() => page.evaluate(twoFrames));
    } while (inflight.count() > 0 || inflight.started() !== seen);
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
