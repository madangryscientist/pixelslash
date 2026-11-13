import type { Browser, BrowserContext, Page } from "playwright";
import { settleCapture, trackInflight, type Inflight } from "./capture.ts";
import {
  newShotContext,
  openPage,
  pinClock,
  type Opened,
  type ShotProgress,
} from "./capture-open.ts";
import type { Route, Stabilise, Variant } from "./config.ts";
import { attemptFailure } from "./crash-retry.ts";
import { CaptureError, CaptureTimeout } from "./errors.ts";
import type { Session } from "./setup.ts";
import {
  emitStory,
  hookChannel,
  previewHooked,
  resetPage,
  switchedState,
} from "./preview-switch.ts";
import { elapsed } from "./timings.ts";

/**
 * One Storybook preview page per capture worker, switched from story to story in place (PS-445).
 * Loading and booting the preview is most of a story shot, so a page kept open and told to render
 * the next story is several times faster than a fresh one. Its PNG is not always byte-equal to a
 * fresh page's (a focus ring, a glyph raster, an antialiased pixel), so a shot taken here is marked
 * `reused` and only `capture --upload` takes one: there every shot meets its baseline before it is
 * reported, and one that differs is shot again on a fresh page.
 */

type Slot = {
  context: BrowserContext;
  page: Page;
  inflight: Inflight;
  progress: ShotProgress;
  /** The story and globals on the page now; unset until its first load. */
  id?: string;
  globals?: string;
};

/** What a pooled shot needs of the shot: the URL, route, variant, settle and the session it signs in with. */
export type PooledShot = {
  url: string;
  route: Route;
  variant: Variant;
  stabilise: Stabilise;
  session: Session | undefined;
  a11y: boolean;
};

/** Idle preview pages, by browser and variant: a worker takes one, shoots on it and puts it back. */
export class PreviewPool {
  private free = new Map<string, Slot[]>();
  private all = new Set<Slot>();

  take(key: string): Slot | undefined {
    return this.free.get(key)?.pop();
  }

  put(key: string, slot: Slot): void {
    const list = this.free.get(key) ?? [];
    list.push(slot);
    this.free.set(key, list);
  }

  /**
   * A new page for `key`. An idle page of another key (a variant the workers are done with) is
   * closed first, so the pool holds about one page per worker, not one per worker per variant.
   */
  async make(browser: Browser, key: string, shot: PooledShot): Promise<Slot> {
    const idle = [...this.free].find(([k, list]) => k !== key && list.length > 0)?.[1].pop();
    if (idle) await this.drop(idle);
    const context = await newShotContext(browser, shot.variant, shot.stabilise, shot.session);
    const progress: ShotProgress = { step: "goto", crashed: false };
    await context.addInitScript(hookChannel);
    await pinClock(context, shot.stabilise);
    const page = await context.newPage();
    page.on("crash", () => (progress.crashed = true));
    const slot: Slot = { context, page, inflight: trackInflight(page), progress };
    this.all.add(slot);
    return slot;
  }

  async drop(slot: Slot): Promise<void> {
    this.all.delete(slot);
    await slot.context.close();
  }

  async close(): Promise<void> {
    const slots = [...this.all];
    this.all.clear();
    this.free.clear();
    await Promise.allSettled(slots.map((s) => s.context.close()));
  }
}

/**
 * Wait for the preview to say `id` has rendered after an in-place switch, or that it failed. The
 * body's `sb-show-main` is still there from the story before, so this reads the channel's phases.
 */
export async function awaitSwitched(
  page: Pick<Page, "waitForFunction">,
  id: string,
  name: string,
  timeoutMs: number,
) {
  let state: { error: string | null } | null;
  try {
    state = await (
      await page.waitForFunction(switchedState, id, { timeout: timeoutMs })
    ).jsonValue();
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError")
      throw new CaptureTimeout(`story ${name} did not render within ${timeoutMs}ms`);
    throw e;
  }
  if (state?.error) throw new CaptureError(`story ${name} errored: ${state.error}`);
}

function storyParts(url: string): { id: string; globals: string } {
  const q = new URL(url).searchParams;
  return { id: q.get("id") ?? "", globals: q.get("globals") ?? "" };
}

/** Whether the page can switch to `id` in place: the preview's channel is hooked and the globals are the same. */
async function canSwitch(slot: Slot, id: string, globals: string): Promise<boolean> {
  if (slot.id === undefined || slot.id === id || slot.globals !== globals) return false;
  return slot.page.evaluate(previewHooked);
}

/**
 * The story on the slot's page: switched in place when it can be, else loaded like a fresh page.
 * `switched` says which: a load is a fresh page's shot, a switch is a reused page's.
 */
async function open(slot: Slot, shot: PooledShot): Promise<Opened & { switched: boolean }> {
  const { page, progress } = slot;
  const { timeoutMs } = shot.stabilise;
  const { id, globals } = storyParts(shot.url);
  // Forgotten first, so a failure part-way never leaves a slot that claims a story it does not show.
  const switchable = await canSwitch(slot, id, globals);
  delete slot.id;
  if (!switchable) {
    const opened = await openPage(page, shot.url, shot.route, {
      timeoutMs,
      progress,
      inflight: slot.inflight,
    });
    Object.assign(slot, { id, globals });
    return { ...opened, switched: false };
  }
  page.setDefaultNavigationTimeout(timeoutMs);
  progress.step = "goto";
  const switching = performance.now();
  await page.evaluate(resetPage);
  await page.evaluate(emitStory, { id });
  const started = Date.now();
  const settling = performance.now();
  progress.step = "settle";
  await awaitSwitched(page, id, shot.route.name, timeoutMs);
  const storyMs = performance.now() - settling;
  const settle = await settleCapture(
    page,
    Math.max(1, timeoutMs - (Date.now() - started)),
    slot.inflight,
  );
  Object.assign(slot, { id, globals });
  return {
    navigateMs: settling - switching,
    settleMs: performance.now() - settling,
    settle,
    storyMs,
    switched: true,
  };
}

/**
 * One attempt at a story on a pooled page. The page goes back to the pool after a good shot, and
 * is closed after a failure, or after an a11y scan, which resumes a paused clock for good.
 * `switched` says the story was switched to in place, not loaded.
 */
export async function pooledAttempt<T>(
  pool: PreviewPool,
  browser: Browser,
  shot: PooledShot,
  capture: (page: Page, opened: Opened, setupMs: number) => Promise<T>,
): Promise<{ out: T; switched: boolean }> {
  const setting = performance.now();
  const key = `${shot.variant.browser}/${shot.variant.name}`;
  const slot = pool.take(key) ?? (await pool.make(browser, key, shot));
  const setupMs = elapsed(setting);
  slot.progress.step = "goto";
  let keep = false;
  try {
    const opened = await open(slot, shot);
    slot.progress.step = "screenshot";
    const out = await capture(slot.page, opened, setupMs);
    keep = !(shot.a11y && shot.stabilise.timers);
    return { out, switched: opened.switched };
  } catch (e) {
    throw await attemptFailure(e, shot.url, slot.progress);
  } finally {
    if (keep) pool.put(key, slot);
    else await pool.drop(slot);
  }
}
