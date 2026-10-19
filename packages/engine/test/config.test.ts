import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const base = { baseUrl: "http://127.0.0.1:3000", routes: ["/"] };

describe("parseConfig", () => {
  test("fills the stabilisation defaults and one desktop variant", () => {
    const config = parseConfig(base);
    expect(config.stabilise).toEqual({
      animations: true,
      caret: true,
      clock: "2026-01-01T00:00:00.000Z",
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
    expect(config.routes).toEqual([{ path: "/", name: "index", masks: [], tags: [] }]);
    expect(config.start).toBeUndefined();
  });

  test("every default is overridable", () => {
    const config = parseConfig({
      ...base,
      stabilise: {
        animations: false,
        caret: false,
        clock: false,
        deviceScaleFactor: 2,
        timeoutMs: 100,
      },
    });
    expect(config.stabilise).toEqual({
      animations: false,
      caret: false,
      clock: false,
      deviceScaleFactor: 2,
      timeoutMs: 100,
    });
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
    });
  });

  test("a start command waits on baseUrl unless it names a ready URL", () => {
    expect(parseConfig({ ...base, start: { command: "bun dev" } }).start).toEqual({
      command: "bun dev",
      readyUrl: base.baseUrl,
      timeoutMs: 60_000,
    });
  });

  test.each([
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
    [{ ...base, stabilise: { clock: "soon" } }, /ISO date or false/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(message);
  });
});
