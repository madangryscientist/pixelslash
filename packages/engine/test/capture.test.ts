import { describe, expect, test } from "vitest";
import { roomyShm, settleCapture, type SettlePage } from "../src/capture.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleCapture", () => {
  test("waits fonts, images, network idle, then two frames — in order", async () => {
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

describe("roomyShm", () => {
  test("answers without throwing", async () => {
    expect(typeof (await roomyShm())).toBe("boolean");
  });
});
