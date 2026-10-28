import type { Browser } from "playwright";
import { launchBrowser } from "./capture.ts";
import type { BrowserName, CaptureConfig } from "./config.ts";
import { CaptureError } from "./errors.ts";
import { signIn, type Session } from "./setup.ts";
import { elapsed } from "./timings.ts";

/**
 * The browsers a capture session holds: one per engine the config's variants name, because a shot
 * is only ever taken, and matched, in the browser its variant names. The config's `setup` runs once,
 * in the first variant's browser; what it leaves (cookies, local storage) is given to every shot.
 */
export type SessionBrowsers = {
  of: (name: BrowserName) => Browser;
  session: Session | undefined;
  /** How long the launches took, together. */
  launchMs: number;
};

/**
 * Launch the browsers into `launched` as they come up, so a failure part-way leaves the ones
 * already open where the caller's `close` can reach them, then sign in once.
 */
export async function launchSessionBrowsers(
  config: CaptureConfig,
  launched: Map<BrowserName, Browser>,
  args: string[],
): Promise<SessionBrowsers> {
  const started = performance.now();
  for (const { browser } of config.variants)
    if (!launched.has(browser)) launched.set(browser, await launchBrowser(browser, args));
  const launchMs = elapsed(started);
  const first = config.variants[0] && launched.get(config.variants[0].browser);
  const session = first && (await signIn(first, config));
  return {
    of: (name) => {
      const found = launched.get(name);
      if (!found) throw new CaptureError(`no ${name} browser: no variant names it`);
      return found;
    },
    session,
    launchMs,
  };
}
