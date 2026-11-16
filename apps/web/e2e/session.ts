import { fileURLToPath } from "node:url";

/**
 * The stub user's session, written once per run by `signed-in.setup.ts` and loaded by the `chromium`
 * project. It lives under `.wrangler/e2e`, which the web server wipes at the start of each run, so it
 * never outlives its D1. Its own module, so `playwright.config.ts` can read it without the fixtures.
 */
export const SIGNED_IN = fileURLToPath(new URL("../.wrangler/e2e/signed-in.json", import.meta.url));

/** A context with no session: for the specs about signing in and about visitors. */
export const SIGNED_OUT = { cookies: [], origins: [] };
