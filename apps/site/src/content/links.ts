import manifest from "../../../web/github-app/manifest.json";

/**
 * No link may lead somewhere a visitor cannot open, so the repository and the hosted app each sit
 * behind one switch that is off until that destination opens. The repository opened on
 * 2026-11-03 (PS-257, PS-292); the hosted app has not.
 */
export const REPO_PUBLIC = true;
export const APP_LIVE = false;

/** The repository, from the same file `docs/capabilities/build.py` reads it from. */
export const REPO_URL: string = manifest.url;
export const APP_URL = "https://app.pixelslash.dev";
export const CONTACT = "hello@hack-cove.com";
