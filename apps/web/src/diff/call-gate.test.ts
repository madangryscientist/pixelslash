import { describe, expect, test } from "vitest";
import { type CallGate, callGate } from "./call-gate";

const LEASE_MS = 1000;

/** A clock that only moves when a waiter sleeps, so a test never waits on real time. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await Promise.resolve();
    },
  };
}

/** A call the test ends by hand, and the order calls began in. `began` resolves when the call runs. */
function started(gate: CallGate, order: string[], name: string) {
  const held = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  const done = gate(async () => {
    order.push(name);
    began.resolve();
    await held.promise;
  });
  return { finish: held.resolve, done, began: began.promise };
}

/** The gate's poll timer, counted: a test awaits `afterPolls(n)` to know waiters looked again while a call ran. */
function countedPolls() {
  let polls = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    sleep: () => {
      polls++;
      for (const w of waiters) if (polls >= w.at) w.resolve();
      return new Promise<void>((resolve) => setTimeout(resolve, 1));
    },
    afterPolls: (n: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ at: polls + n, resolve });
      return promise;
    },
  };
}

describe("callGate", () => {
  test("runs one call at a time, in the order they came", async () => {
    const order: string[] = [];
    const { sleep, afterPolls } = countedPolls();
    const gate = callGate(1, LEASE_MS, { sleep });
    const a = started(gate, order, "a");
    const b = started(gate, order, "b");
    const c = started(gate, order, "c");
    // b and c each look again while a still runs, and neither is let in.
    await a.began;
    await afterPolls(2);
    expect(order).toEqual(["a"]);
    a.finish();
    await a.done;
    await b.began;
    // c looks again while b runs.
    await afterPolls(1);
    expect(order).toEqual(["a", "b"]);
    b.finish();
    await b.done;
    await c.began;
    expect(order).toEqual(["a", "b", "c"]);
    c.finish();
    await c.done;
  });

  test("a call that throws gives its place up and the throw reaches its caller", async () => {
    const gate = callGate(1, LEASE_MS);
    await expect(gate(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(gate(async () => "next")).resolves.toBe("next");
  });

  test("a call cancelled mid-run never finishes, and its lease lets the next one in", async () => {
    const time = fakeTime();
    const gate = callGate(1, LEASE_MS, time);
    void gate(() => new Promise(() => {})); // Its request is gone: no finally will ever run.
    await Promise.resolve();
    await expect(gate(async () => "next")).resolves.toBe("next");
    expect(time.now()).toBeGreaterThanOrEqual(LEASE_MS);
  });

  test("a waiter cancelled in the queue does not hold up the one behind it", async () => {
    const time = fakeTime();
    let polls = 0;
    const gate = callGate(1, LEASE_MS, {
      now: time.now,
      // The first caller's second poll never returns: its request was cancelled while it waited.
      sleep: (ms) => (++polls === 1 ? new Promise(() => {}) : time.sleep(ms)),
    });
    const first = Promise.withResolvers<void>();
    const running = gate(() => first.promise);
    await Promise.resolve();
    void gate(async () => "cancelled before it ran");
    const behind = gate(async () => "behind");
    first.resolve();
    await running;
    await expect(behind).resolves.toBe("behind");
  });

  test("a live waiter that was thought gone joins again and still gets its turn", async () => {
    let t = 0;
    const gate = callGate(1, LEASE_MS, {
      now: () => t,
      sleep: async () => {
        // One long stall of the thread: every waiter looks gone at the next look.
        t += 6000;
        await Promise.resolve();
      },
    });
    const results = await Promise.all([
      gate(async () => "a"),
      gate(async () => "b"),
      gate(async () => "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
