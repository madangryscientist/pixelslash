import { describe, expect, test } from "vitest";
import { release } from "../src/release.ts";

describe("release", () => {
  test("detaches a large buffer's store and frees its bytes", () => {
    const bytes = Buffer.alloc(4 << 20, 7);
    const store = bytes.buffer;
    release(bytes);
    expect(store.detached).toBe(true);
    expect(bytes.byteLength).toBe(0);
  });

  test("leaves a small buffer, and a view onto part of a store, alone", () => {
    const small = Buffer.alloc(1024, 1);
    release(small);
    expect(small.byteLength).toBe(1024);

    const whole = new Uint8Array(4 << 20);
    const view = whole.subarray(16);
    release(view);
    expect(whole.byteLength).toBe(4 << 20);
    expect(view.byteLength).toBe((4 << 20) - 16);
  });

  test("does not throw on a store it cannot detach", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(2 << 20));
    expect(() => release(shared)).not.toThrow();
  });
});
