import { describe, expect, test } from "vitest";
import { parseDevArgs } from "../src/dev.ts";
import { watching } from "../src/dev-loop.ts";

/** A promise that rejects after `ms`, so a missed step fails the test instead of hanging it. */
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref();
    }),
  ]);

/**
 * Raise a save by hand, hold the ignore check open, close (or not), then let the check answer.
 * Returns the runs started. No file event and no fixed sleep: the check's answer says when the
 * callback has read it, and a turn of the event loop after that is when its microtasks are done.
 */
async function closeDuringCheck(closeFirst: boolean): Promise<number> {
  const answer = Promise.withResolvers<string[]>();
  const asked = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const touch = Promise.withResolvers<(path: string) => void>();
  let runs = 0;
  const close = await watching(
    "/unused",
    parseDevArgs([]),
    { run: async () => void (runs += 1) },
    {
      quietMs: 0,
      watch: async (_opts, onChange) => {
        touch.resolve(onChange);
        return () => {};
      },
      ignores: async () => {
        asked.resolve();
        const paths = await answer.promise;
        answered.resolve();
        return paths;
      },
    },
  );
  try {
    (await within(touch.promise, 2000, "the watcher to start"))("saved.txt");
    await within(asked.promise, 2000, "the ignore check to be asked");
    if (closeFirst) close();
    answer.resolve(["saved.txt"]);
    await within(answered.promise, 2000, "the ignore check to answer");
    await new Promise((done) => setImmediate(done));
    return runs;
  } finally {
    close();
  }
}

describe("watching: a save whose ignore check is in flight when the session closes (PS-398)", () => {
  test("a callback already past its debounce starts no run once the closer has run", async () => {
    expect(await closeDuringCheck(true)).toBe(0);
  });

  test("the same save, with the session open, does start a run", async () => {
    expect(await closeDuringCheck(false)).toBe(1);
  });
});
