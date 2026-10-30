import { afterAll, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { CaptureError } from "../src/errors.ts";
import { CAPTURE_CONCURRENCY, captureInto } from "../src/capture-into.ts";
import type { CaptureSession } from "../src/snapshot.ts";
import { cleanupDev, png, tmpDir } from "./dev-fixtures.ts";

afterAll(cleanupDev);

const ROUTES = ["/a", "/b", "/c", "/d", "/e"];

/** A browserless session on five routes × two variants whose shots take `ms(name)` each. */
function session(ms: (name: string) => number, fail?: string) {
  const config = parseConfig({
    baseUrl: "http://127.0.0.1:9",
    routes: ROUTES,
    variants: [
      { name: "wide", viewport: { width: 16, height: 16 } },
      { name: "narrow", viewport: { width: 8, height: 16 } },
    ],
  });
  const seen = { running: 0, most: 0, started: [] as string[] };
  const fake: CaptureSession = {
    config,
    routes: config.routes,
    fingerprintFor: () => ({ image: "version:test", browser: "chromium 1", fonts: "sha256:f" }),
    browserLaunchMs: 0,
    shoot: async (route, variant) => {
      const name = `${route.name}/${variant.name}`;
      seen.started.push(name);
      seen.running++;
      seen.most = Math.max(seen.most, seen.running);
      await Bun.sleep(ms(name));
      seen.running--;
      if (name === fail) throw new CaptureError(`capture settle exceeded on ${name}`);
      return { png: png(), ignore: [], media: [] };
    },
    flush: () => {},
    close: async () => {},
  };
  return { fake, seen };
}

describe("captureInto takes shots at once (PS-195)", () => {
  test("at most CAPTURE_CONCURRENCY run together, and the manifest keeps the config's order", async () => {
    // Earlier shots take longer, so they finish out of order.
    const { fake, seen } = session((name) => (name.startsWith("a") ? 60 : 5));
    const { manifest, shots } = await captureInto(fake, await tmpDir());
    expect(seen.most).toBe(CAPTURE_CONCURRENCY);
    const order = ["wide", "narrow"].flatMap((v) => ROUTES.map((r) => `${r.slice(1)}/${v}`));
    expect(manifest.snapshots.map((e) => `${e.name}/${e.variant.name}`)).toEqual(order);
    expect(shots).toHaveLength(order.length);
  });

  test("a failing shot fails the capture, starts no new shot and waits for the running ones", async () => {
    const { fake, seen } = session((name) => (name === "a/wide" ? 5 : 40), "a/wide");
    await expect(captureInto(fake, await tmpDir())).rejects.toThrow(/settle exceeded on a\/wide/);
    expect(seen.started).toHaveLength(CAPTURE_CONCURRENCY);
    expect(seen.running).toBe(0);
  });
});
