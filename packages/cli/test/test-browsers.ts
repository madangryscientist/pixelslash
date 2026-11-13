import { chromium, firefox, webkit } from "playwright";
import { IMAGE_BROWSERS, isBrowserName, type BrowserName } from "@hackcove/pixelslash-engine";

const types = { chromium, firefox, webkit };

/**
 * The real browsers this run asked for. Chromium always; Firefox and WebKit only when
 * `PIXELSLASH_TEST_BROWSERS` names them (`firefox,webkit`) or says `all`. A browser that was
 * not asked for is never launched or probed, so the gate is the same on every machine.
 */
function requestedBrowsers(value: string | undefined): Set<BrowserName> {
  const asked = new Set<BrowserName>(["chromium"]);
  for (const raw of (value ?? "").split(",")) {
    const name = raw.trim().toLowerCase();
    if (name === "") continue;
    if (name === "all") for (const b of IMAGE_BROWSERS) asked.add(b);
    else if (isBrowserName(name)) asked.add(name);
    else
      throw new Error(
        `PIXELSLASH_TEST_BROWSERS names "${raw.trim()}"; use ${IMAGE_BROWSERS.join(", ")} or all`,
      );
  }
  return asked;
}

/**
 * The browsers the tests run against. One that was asked for and does not launch fails the
 * run, naming it: a silent skip would pass a run that never touched the browser.
 */
export const testBrowsers: ReadonlySet<BrowserName> = requestedBrowsers(
  process.env.PIXELSLASH_TEST_BROWSERS,
);
for (const name of testBrowsers) {
  // Chromium is the default every run needs; its tests fail on their own if it is missing.
  if (name === "chromium") continue;
  try {
    await (await types[name].launch()).close();
  } catch (e) {
    throw new Error(
      `${name} was asked for (PIXELSLASH_TEST_BROWSERS) but does not launch: ${String(e)}`,
      { cause: e },
    );
  }
}
