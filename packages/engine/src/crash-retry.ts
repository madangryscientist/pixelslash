import type { ShotProgress, ShotStep } from "./capture-open.ts";
import { CaptureError, CaptureTimeout } from "./errors.ts";

/**
 * Whether a failed attempt was the page crashing (PS-332): Playwright rejects the pending call
 * with `Page crashed` (a navigation) or `Target crashed` (any call after it), and fires the
 * page's `crash` event. Either is enough. The only test for it.
 */
function pageCrashed(e: unknown, crashEvent: boolean): boolean {
  return crashEvent || (e instanceof Error && /Page crashed|Target crashed/.test(e.message));
}

/**
 * How long a failed attempt waits for its page to report a crash it has not reported yet. When a
 * renderer dies mid-navigation Playwright can reject the pending `goto` with `net::ERR_ABORTED;
 * maybe frame was detached?` before the page's `crash` event fires, so the rejection alone does not
 * say whether the page crashed. Small, because it is spent on every failure that is not already a
 * crash, a timeout and an HTTP error included.
 */
export const CRASH_GRACE_MS = 250;

/** The part of a page this reads: its crash and close events, and whether it is already closed. */
export type CrashWatch = {
  once(event: "crash" | "close", listener: () => void): unknown;
  off(event: "crash" | "close", listener: () => void): unknown;
  isClosed(): boolean;
};

/**
 * Whether the page reports a crash within `CRASH_GRACE_MS`. Ended early by the `crash` event (true)
 * or by the page closing (false: a closed page will report nothing more). A page that stays quiet
 * is not crashed, so a timeout or an HTTP error that nothing crashed is never turned into one.
 */
function crashReportedSoon(page: CrashWatch): Promise<boolean> {
  if (page.isClosed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (crashed: boolean) => {
      clearTimeout(timer);
      page.off("crash", onCrash);
      page.off("close", onClose);
      resolve(crashed);
    };
    const onCrash = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), CRASH_GRACE_MS);
    page.once("crash", onCrash);
    page.once("close", onClose);
  });
}

/**
 * The error one attempt throws: `PageCrash` when its page crashed, else the `CaptureError` it already
 * was or becomes. A rejection that does not say the page crashed gets a short, bounded chance to
 * (`crashReportedSoon`) before it is classified, when the caller passes the page. The pooled
 * preview path does not: it shoots again on a fresh page whatever the class, so a wait there would
 * only slow every failure.
 */
export async function attemptFailure(
  e: unknown,
  url: string,
  progress: ShotProgress,
  page?: CrashWatch,
): Promise<Error> {
  const message = e instanceof Error ? e.message : String(e);
  const crashed =
    pageCrashed(e, progress.crashed) || (page !== undefined && (await crashReportedSoon(page)));
  if (crashed) return new PageCrash(progress.step, message);
  if (e instanceof CaptureError) return e;
  const failed = `capture failed for ${url}: ${message}`;
  return progress.step === "goto" && e instanceof Error && e.name === "TimeoutError"
    ? new CaptureTimeout(failed)
    : new CaptureError(failed);
}

/** One attempt's crash, kept apart from every other failure so `retryOnCrash` retries only this. */
export class PageCrash extends Error {
  constructor(
    readonly step: ShotStep,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run a shot's attempt, and once more when its page crashes (PS-332): chromium under load can lose a
 * page, and one lost page should not cost the whole group. `attempt` makes its own context, so the
 * retry is a fresh one. A second crash fails the shot; a timeout, an HTTP error or a settle failure
 * is not retried, and neither is a third crash.
 */
export async function retryOnCrash<T>(
  attempt: () => Promise<T>,
  shot: {
    route: { name: string };
    variant: { name: string };
    url: string;
    warn: (message: string) => void;
  },
): Promise<T> {
  const name = `${shot.route.name} (${shot.variant.name})`;
  try {
    return await attempt();
  } catch (first) {
    if (!(first instanceof PageCrash)) throw first;
    shot.warn(
      `warning: ${name}: the page crashed during ${first.step}; captured again in a fresh context`,
    );
    try {
      return await attempt();
    } catch (second) {
      if (!(second instanceof PageCrash)) throw second;
      throw new CaptureError(
        `capture failed for ${shot.url}: ${name}: the page crashed during ${second.step} again (${second.message}); the one retry was already spent`,
      );
    }
  }
}
