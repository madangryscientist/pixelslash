import type { Page } from "playwright";
import { settleCapture } from "./capture.ts";
import type { Route } from "./config.ts";
import { CaptureError } from "./errors.ts";
import type { SettleSteps } from "./timings.ts";
import { awaitStory } from "./storybook.ts";

export type Opened = { navigateMs: number; settleMs: number; settle: SettleSteps };

/** Load the page and wait for it to settle; returns how long each took, the page's own time. */
export async function openPage(
  page: Page,
  url: string,
  route: Route,
  timeoutMs: number,
): Promise<Opened> {
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
