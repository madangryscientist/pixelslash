import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  attemptFailure,
  CRASH_GRACE_MS,
  type CrashWatch,
  PageCrash,
  retryOnCrash,
} from "../src/crash-retry.ts";
import type { ShotProgress } from "../src/capture-open.ts";
import { CaptureError } from "../src/errors.ts";

// Fake timers, so the grace period is stepped through and no assertion reads a wall clock.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** What `attemptFailure` reads of a page: `crash` and `close` events, and `isClosed`. */
function fakePage(closed = false) {
  const events = new EventEmitter();
  const page: CrashWatch = {
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
    isClosed: () => closed,
  };
  return { page, events };
}

const url = "http://example.test/";
const progress = (): ShotProgress => ({ step: "goto", crashed: false });

/** Whether the promise has settled, without waiting on it. */
function watch<T>(promise: Promise<T>) {
  const state = { settled: false };
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

describe("a crash the page reports after the call has already been rejected", () => {
  // Playwright can reject the pending goto with ERR_ABORTED before the page's `crash` event fires
  // (PS-467). The fake page proves the classification only; the real-Chromium test in
  // capture-crash.test.ts is the integration proof that Chromium produces such an order.
  test("a goto rejected with ERR_ABORTED, then the crash event, is retried once and the retry's result kept", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    const done = retryOnCrash(
      async () => {
        attempts += 1;
        if (attempts > 1) return "retry's png";
        const { page, events } = fakePage();
        const tracker = progress();
        events.on("crash", () => (tracker.crashed = true));
        // The rejection comes first, the crash event a moment after it.
        setTimeout(() => events.emit("crash"), 20);
        throw await attemptFailure(
          new Error("page.goto: net::ERR_ABORTED; maybe frame was detached?"),
          url,
          tracker,
          page,
        );
      },
      {
        route: { name: "index" },
        variant: { name: "desktop" },
        url,
        warn: (m) => warnings.push(m),
      },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await done).toBe("retry's png");
    expect(attempts).toBe(2);
    expect(warnings).toEqual([
      "warning: index (desktop): the page crashed during goto; captured again in a fresh context",
    ]);
  });

  test("a crash after the grace period is too late, and the listeners are gone", async () => {
    const { page, events } = fakePage();
    const failing = attemptFailure(new Error("page.goto: net::ERR_ABORTED"), url, progress(), page);
    const settled = watch(failing);
    await vi.advanceTimersByTimeAsync(CRASH_GRACE_MS - 1);
    expect(settled.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await failing;
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure).not.toBeInstanceOf(PageCrash);
    expect(events.listenerCount("crash")).toBe(0);
    expect(events.listenerCount("close")).toBe(0);
  });
});

describe("a failure that is not a crash stays as it was, and costs at most the grace period", () => {
  test("an HTTP 500 comes back a CaptureError once the grace period has passed, and not before", async () => {
    const { page } = fakePage();
    const failing = attemptFailure(
      new CaptureError(`capture failed for ${url}: HTTP 500`),
      url,
      progress(),
      page,
    );
    const settled = watch(failing);
    await vi.advanceTimersByTimeAsync(CRASH_GRACE_MS - 1);
    expect(settled.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await failing;
    expect(settled.settled).toBe(true);
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure).not.toBeInstanceOf(PageCrash);
    expect(failure.message).toBe(`capture failed for ${url}: HTTP 500`);
  });

  test("a closed page is classified at once, with no wait", async () => {
    const { page } = fakePage(true);
    const failure = await attemptFailure(
      new Error("page.goto: Timeout 4000ms exceeded."),
      url,
      progress(),
      page,
    );
    expect(failure).toBeInstanceOf(CaptureError);
    expect(failure.message).toContain("Timeout 4000ms exceeded");
  });

  test("a page that closes during the wait ends it early, not crashed", async () => {
    const { page, events } = fakePage();
    const failing = attemptFailure(new Error("page.goto: net::ERR_ABORTED"), url, progress(), page);
    await vi.advanceTimersByTimeAsync(10);
    events.emit("close");
    expect(await failing).not.toBeInstanceOf(PageCrash);
  });

  test("a crash already known is not waited for", async () => {
    const { page } = fakePage();
    const known: ShotProgress = { step: "settle", crashed: true };
    expect(await attemptFailure(new Error("anything"), url, known, page)).toBeInstanceOf(PageCrash);
  });
});
