import { describe, expect, test } from "vitest";
import {
  roomyShm,
  settleCapture,
  trackInflight,
  type Inflight,
  type SettlePage,
} from "../src/capture.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleCapture", () => {
  test("with no tracker it waits fonts, images, networkidle, then two frames, in order", async () => {
    const calls: string[] = [];
    const pending: Array<() => void> = [];
    const gated = (label: string) => {
      calls.push(label);
      return new Promise<void>((resolve) => pending.push(resolve));
    };
    const page: SettlePage = {
      evaluate: () => gated("evaluate"),
      waitForFunction: () => gated("waitForFunction"),
      waitForLoadState: (state) => gated(`loadState:${state}`),
    };
    const release = () => pending.shift()!();
    const done = settleCapture(page, 5_000);
    await tick();
    expect(calls).toEqual(["evaluate"]);
    release();
    await tick();
    expect(calls).toEqual(["evaluate", "waitForFunction"]);
    release();
    await tick();
    expect(calls).toEqual(["evaluate", "waitForFunction", "loadState:networkidle"]);
    release();
    await tick();
    expect(calls).toEqual(["evaluate", "waitForFunction", "loadState:networkidle", "evaluate"]);
    release();
    // Each condition is timed apart (PS-195).
    expect(await done).toEqual({
      fontsMs: expect.any(Number),
      imagesMs: expect.any(Number),
      networkIdleMs: expect.any(Number),
      framesMs: expect.any(Number),
    });
  });

  test("is bounded: a page that never settles rejects at the timeout", async () => {
    const page: SettlePage = {
      evaluate: () => new Promise<never>(() => {}),
      waitForFunction: () => new Promise<never>(() => {}),
      waitForLoadState: () => new Promise<never>(() => {}),
    };
    const started = Date.now();
    await expect(settleCapture(page, 40)).rejects.toThrow(/capture settle exceeded 40ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/** A page that records its calls, with `evaluate` (fonts, frames) and `waitForFunction` answering at once. */
function recordingPage(calls: string[]): SettlePage {
  return {
    evaluate: async () => void calls.push("evaluate"),
    waitForFunction: async () => void calls.push("waitForFunction"),
    waitForLoadState: async (state) => void calls.push(`loadState:${state}`),
  };
}

/** A page's request events, fired by hand. */
function eventPage() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe("settleCapture with an in-flight tracker", () => {
  test("waits for the count to reach zero before the frames, and never asks for networkidle", async () => {
    const events = eventPage();
    const inflight = trackInflight(events);
    events.emit("request");
    const calls: string[] = [];
    const done = settleCapture(recordingPage(calls), 5_000, inflight);
    await tick();
    // Fonts and images are done; the one request holds the network wait, so no frames yet.
    expect(calls).toEqual(["evaluate", "waitForFunction"]);
    events.emit("requestfinished");
    const steps = await done;
    expect(calls).toEqual(["evaluate", "waitForFunction", "evaluate"]);
    expect(steps.networkIdleMs).toBeGreaterThanOrEqual(0);
  });

  test("a request that starts during the frames makes it wait again", async () => {
    const events = eventPage();
    const inflight = trackInflight(events);
    const calls: string[] = [];
    let frames = 0;
    const page: SettlePage = {
      evaluate: async () => {
        calls.push("evaluate");
        // The second evaluate is the first frame pair: a request starts inside it.
        if (++frames === 2) events.emit("request");
      },
      waitForFunction: async () => void calls.push("waitForFunction"),
      waitForLoadState: async () => void calls.push("networkidle"),
    };
    const done = settleCapture(page, 5_000, inflight);
    await tick();
    await tick();
    expect(calls).toEqual(["evaluate", "waitForFunction", "evaluate"]);
    // Still waiting: the count is 1, so the frames have not run a second time.
    events.emit("requestfailed");
    await done;
    expect(calls).toEqual(["evaluate", "waitForFunction", "evaluate", "evaluate"]);
  });

  test("a request that started and finished inside the frames still makes it wait again", async () => {
    const events = eventPage();
    const inflight = trackInflight(events);
    let frames = 0;
    const page: SettlePage = {
      evaluate: async () => {
        if (++frames === 2) {
          events.emit("request");
          events.emit("requestfinished");
        }
      },
      waitForFunction: async () => {},
      waitForLoadState: async () => {},
    };
    await settleCapture(page, 5_000, inflight);
    // fonts, then the frames twice.
    expect(frames).toBe(3);
  });

  test("a request that never finishes fails at the timeout", async () => {
    const events = eventPage();
    const inflight = trackInflight(events);
    events.emit("request");
    const started = Date.now();
    await expect(settleCapture(recordingPage([]), 40, inflight)).rejects.toThrow(
      /capture settle exceeded 40ms/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("trackInflight", () => {
  test("counts requests, finished and failed alike, and never goes below zero", () => {
    const events = eventPage();
    const inflight: Inflight = trackInflight(events);
    events.emit("request");
    events.emit("request");
    expect(inflight.count()).toBe(2);
    events.emit("requestfinished");
    events.emit("requestfailed");
    expect(inflight.count()).toBe(0);
    // A finish for a request made before the tracker attached.
    events.emit("requestfinished");
    expect(inflight.count()).toBe(0);
  });

  test("idle resolves when the last request ends", async () => {
    const events = eventPage();
    const inflight = trackInflight(events);
    events.emit("request");
    let idle = false;
    void inflight.idle().then(() => (idle = true));
    await tick();
    expect(idle).toBe(false);
    events.emit("requestfinished");
    await tick();
    expect(idle).toBe(true);
  });
});

describe("roomyShm", () => {
  test("answers without throwing", async () => {
    expect(typeof (await roomyShm())).toBe("boolean");
  });
});
