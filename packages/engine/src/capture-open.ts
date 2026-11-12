import type { Browser, BrowserContext, Page } from "playwright";
import { keepNativeRaf, settleCapture } from "./capture.ts";
import type { Route, Stabilise, Variant } from "./config.ts";
import type { Session } from "./setup.ts";
import { CaptureError } from "./errors.ts";
import type { CaptureSteps, SettleSteps } from "./timings.ts";
import { awaitStory } from "./storybook.ts";

/** `storyMs` is the Storybook render wait, which is inside `settleMs`; absent on a route that is not a story. */
export type Opened = {
  navigateMs: number;
  settleMs: number;
  settle: SettleSteps;
  storyMs?: number;
};

/** A shot's capture steps: what opening the page measured, with the setup before it and the screenshot and measure after. */
export function stepsOf(
  opened: Opened,
  parts: { setupMs: number; screenshotMs: number; measureMs: number },
): CaptureSteps {
  const { navigateMs, settleMs, settle, storyMs } = opened;
  return {
    navigateMs: Math.round(navigateMs),
    settleMs: Math.round(settleMs),
    settle,
    ...parts,
    ...(storyMs !== undefined && { storyMs: Math.round(storyMs) }),
  };
}

/** The part of a shot that was running; a crash names it (PS-332). */
export type ShotStep = "goto" | "settle" | "screenshot";

/** Where a shot is, written as it goes so a failure can name the step it was in, and whether its page crashed. */
export type ShotProgress = { step: ShotStep; crashed: boolean };

/** Load the page and wait for it to settle; returns how long each took, the page's own time. */
export async function openPage(
  page: Page,
  url: string,
  route: Route,
  { timeoutMs, progress }: { timeoutMs: number; progress: ShotProgress },
): Promise<Opened> {
  page.setDefaultNavigationTimeout(timeoutMs);
  progress.step = "goto";
  const loading = performance.now();
  const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
  const settling = performance.now();
  if (!resp) throw new CaptureError(`capture failed for ${url}: no response`);
  if (resp.status() >= 400)
    throw new CaptureError(`capture failed for ${url}: HTTP ${resp.status()}`);
  progress.step = "settle";
  // A story's own render signal and the generic settle share one budget.
  const started = Date.now();
  const storyMs = route.storybook ? await storyWait(page, route.name, timeoutMs) : undefined;
  const settle = await settleCapture(page, Math.max(1, timeoutMs - (Date.now() - started)));
  return {
    navigateMs: settling - loading,
    settleMs: performance.now() - settling,
    settle,
    ...(storyMs !== undefined && { storyMs }),
  };
}

/** How long the story's own render signal took, unrounded. */
async function storyWait(page: Page, name: string, timeoutMs: number): Promise<number> {
  const waiting = performance.now();
  await awaitStory(page, name, timeoutMs);
  return performance.now() - waiting;
}

/** The context a shot is taken in: its variant's viewport and theme, and the session setup left. */
export function newShotContext(
  browser: Browser,
  variant: Variant,
  { deviceScaleFactor }: Stabilise,
  session: Session | undefined,
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: variant.viewport,
    deviceScaleFactor,
    colorScheme: variant.theme,
    ...(session && { storageState: session }),
  });
}

/**
 * Pin the page clock before navigation. With `timers` it is fake timers installed and paused at the
 * instant, so nothing the page schedules fires on its own, and the clock is never advanced after
 * (the settle uses the browser's own frames; see `keepNativeRaf`). Without, only Date is fixed and
 * timers run. A real clock is left alone.
 */
export async function pinClock(
  context: BrowserContext,
  { clock, timers }: Stabilise,
): Promise<void> {
  if (clock === false) return;
  if (!timers) return context.clock.setFixedTime(clock);
  await context.addInitScript(keepNativeRaf);
  await context.clock.install({ time: clock });
  await context.clock.pauseAt(clock);
}
