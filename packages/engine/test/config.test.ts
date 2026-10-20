import { describe, expect, test } from "vitest";
import { parseConfig, resolveDiff } from "../src/config.ts";

const base = { baseUrl: "http://127.0.0.1:3000", routes: ["/"] };

describe("parseConfig", () => {
  test("fills the stabilisation defaults and one desktop variant", () => {
    const config = parseConfig(base);
    expect(config.stabilise).toEqual({
      animations: true,
      caret: true,
      clock: "2026-01-01T00:00:00.000Z",
      timers: true,
      deviceScaleFactor: 1,
      timeoutMs: 8_000,
    });
    expect(config.variants).toEqual([
      {
        name: "chromium-1280x720-light",
        browser: "chromium",
        viewport: { width: 1280, height: 720 },
        theme: "light",
      },
    ]);
    expect(config.routes).toEqual([
      { path: "/", name: "index", masks: [], tags: [], diff: {}, variantDiff: {} },
    ]);
    expect(config.start).toBeUndefined();
  });

  test("every default is overridable", () => {
    const config = parseConfig({
      ...base,
      stabilise: {
        animations: false,
        caret: false,
        clock: false,
        timers: false,
        deviceScaleFactor: 2,
        timeoutMs: 100,
      },
    });
    expect(config.stabilise).toEqual({
      animations: false,
      caret: false,
      clock: false,
      timers: false,
      deviceScaleFactor: 2,
      timeoutMs: 100,
    });
  });

  test("timers follow the clock unless set: a real clock leaves them running", () => {
    expect(parseConfig({ ...base, stabilise: { clock: false } }).stabilise.timers).toBe(false);
    expect(parseConfig({ ...base, stabilise: { timers: false } }).stabilise.timers).toBe(false);
  });

  test("global masks and tags apply to every route, before the route's own", () => {
    const config = parseConfig({
      ...base,
      masks: [".clock"],
      tags: ["web"],
      routes: [
        "/",
        {
          path: "/pricing/",
          masks: [{ x: 0, y: 0, width: 10, height: 5 }],
          tags: ["web", "billing"],
        },
      ],
    });
    expect(config.routes[1]).toEqual({
      path: "/pricing/",
      name: "pricing",
      masks: [".clock", { x: 0, y: 0, width: 10, height: 5 }],
      tags: ["web", "billing"],
      diff: {},
      variantDiff: {},
    });
  });

  test("upload names a server and a base branch, both optional", () => {
    expect(parseConfig(base).upload).toEqual({ server: undefined, baseBranch: undefined });
    expect(
      parseConfig({ ...base, upload: { server: "https://ps.example", baseBranch: "develop" } })
        .upload,
    ).toEqual({ server: "https://ps.example", baseBranch: "develop" });
  });

  test("a start command waits on baseUrl unless it names a ready URL", () => {
    expect(parseConfig({ ...base, start: { command: "bun dev" } }).start).toEqual({
      command: "bun dev",
      readyUrl: base.baseUrl,
      timeoutMs: 60_000,
    });
  });

  test.each([
    [{ ...base, diff: { threshold: 1.5 } }, /diff\.threshold must be a number from 0 to 1/],
    [{ ...base, diff: { threshold: "0.2" } }, /diff\.threshold must be a number from 0 to 1/],
    [
      { ...base, diff: { minChangedPixels: 1.5 } },
      /diff\.minChangedPixels must be a non-negative integer/,
    ],
    [
      { ...base, diff: { minChangedRatio: -0.1 } },
      /diff\.minChangedRatio must be a number from 0 to 1/,
    ],
    [
      { ...base, diff: { mergeDistance: 2.5 } },
      /diff\.mergeDistance must be a non-negative integer/,
    ],
    [
      { ...base, diff: { minRegionArea: -1 } },
      /diff\.minRegionArea must be a non-negative integer/,
    ],
    [{ ...base, diff: { noiseAmplitude: 2 } }, /diff\.noiseAmplitude must be a number from 0 to 1/],
    [{ ...base, diff: { maxShift: 2 } }, /diff\.maxShift must be a number from 0 to 1/],
    [{ ...base, diff: { treshold: 0.1 } }, /diff\.treshold is not a diff option/],
    [{ ...base, diff: 0.1 }, /diff must be an object/],
    [
      { ...base, routes: [{ path: "/", diff: { minChangedPixels: -1 } }] },
      /routes\[0\]\.diff\.minChangedPixels must be a non-negative integer/,
    ],
    [
      { ...base, routes: [{ path: "/", variants: { phone: { diff: {} } } }] },
      /routes\[0\]\.variants\.phone names no variant \(have chromium-1280x720-light\)/,
    ],
    [
      {
        ...base,
        routes: [
          { path: "/", variants: { "chromium-1280x720-light": { diff: { threshold: 2 } } } },
        ],
      },
      /routes\[0\]\.variants\.chromium-1280x720-light\.diff\.threshold must be a number from 0 to 1/,
    ],
    [
      {
        ...base,
        routes: [{ path: "/", variants: { "chromium-1280x720-light": { tolerance: {} } } }],
      },
      /\.tolerance is not a variant option \(diff\)/,
    ],
    [{ ...base, baseUrl: "nope" }, /baseUrl must be a URL/],
    [{ ...base, routes: [] }, /routes must list at least one path/],
    [{ ...base, routes: ["pricing"] }, /must start with \//],
    [{ ...base, routes: ["/a", { path: "/b", name: "a" }] }, /two entries named "a"/],
    [{ ...base, variants: [{ browser: "firefox" }] }, /must be one the image ships: chromium/],
    [{ ...base, variants: [{ theme: "sepia" }] }, /"light" or "dark"/],
    [
      { ...base, masks: [{ x: 0, y: 0, width: 0, height: 1 }] },
      /masks\[0\]\.width must be a positive integer/,
    ],
    [{ ...base, upload: { server: "ftp://x" } }, /upload\.server must be an http\(s\) URL/],
    [{ ...base, upload: "https://ps.example" }, /upload must be/],
    [{ ...base, stabilise: { clock: "soon" } }, /ISO date or false/],
    [{ ...base, stabilise: { timers: "yes" } }, /stabilise.timers must be true or false/],
    [{ ...base, stabilise: { clock: false, timers: true } }, /needs a clock to pause/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(message);
  });
});

describe("resolveDiff", () => {
  const config = parseConfig({
    baseUrl: "http://127.0.0.1:3000",
    diff: { threshold: 0.1, minChangedPixels: 10, mergeDistance: 40 },
    variants: [{ name: "desktop" }, { name: "mobile-dark", theme: "dark" }],
    routes: [
      "/",
      { path: "/pricing", diff: { threshold: 0.05, minChangedRatio: 0.001 } },
      {
        path: "/dashboard",
        diff: { threshold: 0.05 },
        variants: { "mobile-dark": { diff: { threshold: 0.3, minChangedPixels: 50 } } },
      },
    ],
  });
  const resolve = (route: number, variant: number) =>
    resolveDiff(config, config.routes[route]!, config.variants[variant]!);

  test("variant > route > project > engine default, key by key", () => {
    expect(resolve(0, 0)).toEqual({ threshold: 0.1, minChangedPixels: 10, mergeDistance: 40 });
    expect(resolve(1, 0)).toEqual({
      threshold: 0.05,
      minChangedPixels: 10,
      minChangedRatio: 0.001,
      mergeDistance: 40,
    });
    expect(resolve(2, 0)).toEqual({ threshold: 0.05, minChangedPixels: 10, mergeDistance: 40 });
    expect(resolve(2, 1)).toEqual({ threshold: 0.3, minChangedPixels: 50, mergeDistance: 40 });
  });

  test("no diff anywhere resolves to {}: the engine default is not baked in", () => {
    const plain = parseConfig(base);
    expect(resolveDiff(plain, plain.routes[0]!, plain.variants[0]!)).toEqual({});
  });

  test("0 is a value, not an absence", () => {
    const strict = parseConfig({
      ...base,
      diff: { threshold: 0.2 },
      routes: [{ path: "/", diff: { threshold: 0 } }],
    });
    expect(resolveDiff(strict, strict.routes[0]!, strict.variants[0]!)).toEqual({ threshold: 0 });
  });
});
