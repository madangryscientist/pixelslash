import type { ShotProgress, ShotStep } from "./capture-open.ts";
import { CaptureError } from "./errors.ts";

/**
 * Whether a failed attempt was the page crashing (PS-332): Playwright rejects the pending call
 * with `Page crashed` (a navigation) or `Target crashed` (any call after it), and fires the
 * page's `crash` event. Either is enough. The only test for it.
 */
function pageCrashed(e: unknown, crashEvent: boolean): boolean {
  return crashEvent || (e instanceof Error && /Page crashed|Target crashed/.test(e.message));
}

/** The error one attempt throws: `PageCrash` when its page crashed, else the `CaptureError` it already was or becomes. */
export function attemptFailure(e: unknown, url: string, progress: ShotProgress): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (pageCrashed(e, progress.crashed)) return new PageCrash(progress.step, message);
  return e instanceof CaptureError ? e : new CaptureError(`capture failed for ${url}: ${message}`);
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
