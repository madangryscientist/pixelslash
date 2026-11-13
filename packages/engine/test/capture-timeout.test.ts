import { describe, expect, test } from "vitest";
import type { Page } from "playwright";
import { scanA11y } from "../src/a11y.ts";
import { attemptFailure } from "../src/crash-retry.ts";
import { CaptureError, CaptureTimeout } from "../src/errors.ts";
import { awaitSwitched } from "../src/preview-pool.ts";
import { type SettlePage, settleCapture } from "../src/settle.ts";
import { awaitStory } from "../src/storybook.ts";

/**
 * A timeout is a type (PS-474): `captureInto` sets a `CaptureTimeout` aside and shoots it again
 * alone, so each place that runs out of time has to throw one, with the message it always had.
 * Browserless: each site gets a page whose wait ends the way Playwright's does.
 */

const playwrightTimeout = () =>
  Object.assign(new Error("Timeout 40ms exceeded."), { name: "TimeoutError" });
const pageThatThrows = (e: Error): Pick<Page, "waitForFunction"> => ({
  waitForFunction: () => Promise.reject(e),
});
const never = () => new Promise<never>(() => {});

describe("every place that runs out of time throws a CaptureTimeout", () => {
  test("a story that never renders (a fresh page)", async () => {
    const failing = awaitStory(pageThatThrows(playwrightTimeout()), "ui-x-one", 40);
    await expect(failing).rejects.toBeInstanceOf(CaptureTimeout);
    await expect(failing).rejects.toThrow("story ui-x-one did not render within 40ms");
  });

  test("a story that never renders (a pooled page switched in place)", async () => {
    const failing = awaitSwitched(pageThatThrows(playwrightTimeout()), "ui-x--one", "ui-x-one", 40);
    await expect(failing).rejects.toBeInstanceOf(CaptureTimeout);
    await expect(failing).rejects.toThrow("story ui-x-one did not render within 40ms");
  });

  test("a page that never settles", async () => {
    const page: SettlePage = { evaluate: never, waitForFunction: never, waitForLoadState: never };
    const failing = settleCapture(page, 20);
    await expect(failing).rejects.toBeInstanceOf(CaptureTimeout);
    await expect(failing).rejects.toThrow("capture settle exceeded 20ms");
  });

  test("a goto that Playwright times out", async () => {
    const failure = await attemptFailure(playwrightTimeout(), "http://x.test/", {
      step: "goto",
      crashed: false,
    });
    expect(failure).toBeInstanceOf(CaptureTimeout);
    expect(failure.message).toBe("capture failed for http://x.test/: Timeout 40ms exceeded.");
  });
});

describe("what is not a timeout stays a plain CaptureError (a story that errors: storybook.test.ts)", () => {
  test("a screenshot that Playwright times out is not set aside", async () => {
    const failure = await attemptFailure(playwrightTimeout(), "http://x.test/", {
      step: "screenshot",
      crashed: false,
    });
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure).not.toBeInstanceOf(CaptureTimeout);
  });

  test("an accessibility scan that runs out of its own budget", async () => {
    const page: Pick<Page, "evaluate"> = { evaluate: never };
    const failing = scanA11y(page, 20);
    await expect(failing).rejects.toThrow("accessibility scan exceeded 20ms");
    await expect(failing).rejects.not.toBeInstanceOf(CaptureTimeout);
  });

  test("a goto that fails for another reason", async () => {
    const failure = await attemptFailure(
      new Error("net::ERR_CONNECTION_REFUSED"),
      "http://x.test/",
      { step: "goto", crashed: false },
    );
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure).not.toBeInstanceOf(CaptureTimeout);
  });
});
