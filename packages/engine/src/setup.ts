import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { CaptureConfig } from "./config.ts";
import { CaptureError, UsageError } from "./errors.ts";

/** What a config's `setup` module gets: a page in a fresh context, its context, and the config's `baseUrl` (also the context's `baseURL`). */
export type SetupArgs = { page: Page; context: BrowserContext; baseUrl: string };

/**
 * The default export of a config's `setup` module. It runs once, after `start` and before the
 * first shot, and whatever it leaves in its context (cookies, local storage) is given to every
 * shot. So it can sign in through a form, or put a saved session's cookies in with
 * `context.addCookies`. The session is held in memory only: it is not written to the snapshot
 * dir, the manifest or an upload.
 */
export type CaptureSetup = (args: SetupArgs) => Promise<void>;

/** A context's cookies and local storage, as Playwright's `storageState` gives and takes them. */
export type Session = Awaited<ReturnType<BrowserContext["storageState"]>>;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isSetup(v: unknown): v is CaptureSetup {
  return typeof v === "function";
}

async function loadSetup(path: string): Promise<CaptureSetup> {
  const mod: unknown = await import(resolve(path)).catch((e: unknown) => {
    throw new UsageError(`config: setup ${path} could not be loaded: ${message(e)}`);
  });
  const setup = typeof mod === "object" && mod !== null && "default" in mod ? mod.default : null;
  if (!isSetup(setup)) throw new UsageError(`config: setup ${path} must default-export a function`);
  return setup;
}

/**
 * Run the config's `setup`, if it has one, in a fresh context (the first variant's viewport, the
 * real clock: a sign-in may need it) and keep what it left in that context. No setup: no session.
 */
export async function signIn(
  browser: Browser,
  config: CaptureConfig,
): Promise<Session | undefined> {
  if (config.setup === undefined) return undefined;
  const path = config.setup;
  const setup = await loadSetup(path);
  const [first] = config.variants;
  const context = await browser.newContext({
    ...(first && { viewport: first.viewport }),
    baseURL: config.baseUrl,
  });
  try {
    const page = await context.newPage();
    await setup({ page, context, baseUrl: config.baseUrl });
    return await context.storageState();
  } catch (e) {
    throw new CaptureError(`setup ${path} failed: ${message(e)}`);
  } finally {
    await context.close();
  }
}
