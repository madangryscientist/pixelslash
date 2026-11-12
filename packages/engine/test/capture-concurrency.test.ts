import { afterAll, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { CaptureError } from "../src/errors.ts";
import { DEFAULT_CONCURRENCY_CAP, captureInto, defaultConcurrency } from "../src/capture-into.ts";
import type { CaptureSession } from "../src/snapshot.ts";
import { runIteration } from "../src/dev-run.ts";
import { cleanupDev, png, tmpDir, tmpStore } from "./dev-fixtures.ts";

afterAll(cleanupDev);

const ROUTES = ["/a", "/b", "/c", "/d", "/e"];

/** A browserless session on five routes × two variants whose shots take `ms(name)` each. */
function session(ms: (name: string) => number, fail?: string, concurrency?: number) {
  const config = parseConfig({
    baseUrl: "http://127.0.0.1:9",
    ...(concurrency === undefined ? {} : { concurrency }),
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

describe("captureInto takes shots at once (PS-195, PS-436)", () => {
  test.each([1, 6])(
    "at most %i run together, and the manifest keeps the config's order",
    async (n) => {
      // Earlier shots take longer, so they finish out of order.
      const { fake, seen } = session((name) => (name.startsWith("a") ? 60 : 5));
      const { manifest, shots } = await captureInto(fake, await tmpDir(), n);
      expect(seen.most).toBe(n);
      const order = ["wide", "narrow"].flatMap((v) => ROUTES.map((r) => `${r.slice(1)}/${v}`));
      expect(manifest.snapshots.map((e) => `${e.name}/${e.variant.name}`)).toEqual(order);
      expect(shots).toHaveLength(order.length);
    },
  );

  test("without an argument the config's concurrency is used", async () => {
    const { fake, seen } = session(() => 20, undefined, 3);
    await captureInto(fake, await tmpDir());
    expect(seen.most).toBe(3);
  });

  test("without either, the default for the machine is used", async () => {
    const { fake, seen } = session(() => 20);
    await captureInto(fake, await tmpDir());
    expect(seen.most).toBe(Math.min(defaultConcurrency(), 10));
  });

  test.each([4, 6])(
    "a failing shot starts no new shot and waits for the running ones (%i)",
    async (n) => {
      const { fake, seen } = session((name) => (name === "a/wide" ? 5 : 40), "a/wide");
      await expect(captureInto(fake, await tmpDir(), n)).rejects.toThrow(
        /settle exceeded on a\/wide/,
      );
      expect(seen.started).toHaveLength(n);
      expect(seen.running).toBe(0);
    },
  );
});

describe("defaultConcurrency", () => {
  test("is the cap on a big machine and the core count on a small one, at least 1", () => {
    expect(defaultConcurrency(64)).toBe(DEFAULT_CONCURRENCY_CAP);
    expect(defaultConcurrency(2)).toBe(2);
    expect(defaultConcurrency(0)).toBe(1);
  });
});

describe("dev still takes one shot at a time (PS-436)", () => {
  test("a config that asks for six workers does not change a dev run", async () => {
    const { fake, seen } = session(() => 15, undefined, 6);
    await runIteration({ store: await tmpStore(), session: fake, target: "index", maxBytes: 1e9 });
    expect(seen.started).toHaveLength(ROUTES.length * 2);
    expect(seen.most).toBe(1);
  });
});
