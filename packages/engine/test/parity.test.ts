import { describe, expect, test } from "vitest";
import type { MetricsPart } from "../src/metrics-entry.ts";
import { compareParity, staleDeclarations, type ParitySide } from "../src/parity.ts";
import {
  EMPTY_MANIFEST,
  parseParityManifest,
  type ParityManifest,
  type ParityPlatform,
} from "../src/parity-manifest.ts";

const fail = (where: string, what: string): never => {
  throw new Error(`${where} ${what}`);
};

const manifestOf = (json: unknown): ParityManifest => parseParityManifest(json, "m", fail);

const part = (over: Partial<MetricsPart> = {}): MetricsPart => ({
  box: { x: 0, y: 0, w: 96, h: 40 },
  ...over,
});

const side = (
  platform: ParityPlatform,
  scale: number | null,
  parts: Record<string, MetricsPart>,
): ParitySide => ({
  platform,
  scale,
  metrics: { version: "1.0", root: "button", parts },
});

const font = (size: number) => part({ font: { size, weight: 600 } });
const colored = (bg: string) => part({ color: { bg } });
const h = (v: number) => part({ box: { x: 0, y: 0, w: 96, h: v } });

const compare = (a: ParitySide, b: ParitySide, manifest: ParityManifest = EMPTY_MANIFEST) =>
  compareParity({ name: "Button/md-primary", theme: "dark", a, b, manifest });

describe("tolerance", () => {
  test("at scale 3 a 0.3 px box difference matches and 0.5 does not", () => {
    const base = part();
    const near = compare(
      side("android", 3, { button: base }),
      side("ios", 3, { button: part({ box: { ...base.box, h: 40.3 } }) }),
    );
    expect(near.mismatches).toEqual([]);
    const far = compare(
      side("android", 3, { button: base }),
      side("ios", 3, { button: part({ box: { ...base.box, h: 40.5 } }) }),
    );
    expect(far.mismatches).toHaveLength(1);
  });

  test("scales 2 and 3 give a tolerance of 0.5", () => {
    const r = compare(
      side("android", 2, { button: part() }),
      side("ios", 3, { button: part({ box: { x: 0, y: 0, w: 96, h: 40.5 } }) }),
    );
    expect(r.tolerance).toBe(0.5);
    expect(r.mismatches).toEqual([]);
  });

  test("a web side with no recorded scale counts as 1 and says so", () => {
    const r = compare(
      side("web", null, { button: part() }),
      side("android", 3, { button: part() }),
    );
    expect(r.tolerance).toBe(1);
    expect(r.sides).toEqual([
      { platform: "web", scale: 1, scale_source: "default" },
      { platform: "android", scale: 3, scale_source: "recorded" },
    ]);
  });

  test("a font size difference of 0.5 fails", () => {
    const r = compare(
      side("web", 2, { button: font(14) }),
      side("android", 2, { button: font(14.5) }),
    );
    expect(r.mismatches.map((m) => m.field)).toEqual(["font.size"]);
  });
});

describe("the drill", () => {
  test("several clauses name the platforms once, and sides are ordered web first", () => {
    const web = side("web", null, { button: part({ gap: 8 }) });
    const android = side("android", 3, {
      button: part({ gap: 6, box: { x: 0, y: 0, w: 96, h: 38 } }),
    });
    const r = compare(android, web);
    expect(r.line).toBe(
      "Button/md-primary dark: button height 40 web vs 38 android; button gap 8 vs 6",
    );
  });
});

describe("parts and fields", () => {
  test("a part on one side only is a mismatch; a missing field is not", () => {
    const web = side("web", null, { button: part({ gap: 8 }), "button.icon": part() });
    const android = side("android", 3, { button: part() });
    const r = compare(web, android);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatchObject({
      part: "button.icon",
      field: null,
      kind: "missing-part",
    });
    expect(r.line).toBe("Button/md-primary dark: button.icon missing on android");
  });

  test("a field one side did not measure is not compared and not read as zero", () => {
    const r = compare(
      side("web", null, {
        button: part({ gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } }),
      }),
      side("android", 3, { button: part() }),
    );
    expect(r.mismatches).toEqual([]);
    expect(r.line).toBeNull();
  });
});

describe("colours", () => {
  const allow = manifestOf({
    version: 1,
    colors: [{ web: "#ff0000", native: "#f50a05" }],
  });

  test("a different colour fails; no tolerance, alpha included", () => {
    const r = compare(
      side("web", null, { button: colored("#ff0000") }),
      side("android", 3, { button: colored("#ff0000ee") }),
    );
    expect(r.mismatches.map((m) => m.field)).toEqual(["color.bg"]);
  });

  test("an allowlisted out-of-gamut pair passes", () => {
    const r = compare(
      side("web", null, { button: colored("#ff0000") }),
      side("android", 3, { button: colored("#f50a05") }),
      allow,
    );
    expect(r.mismatches).toEqual([]);
  });

  test("the same web colour against a different native hex fails", () => {
    const r = compare(
      side("web", null, { button: colored("#ff0000") }),
      side("android", 3, { button: colored("#f50a06") }),
      allow,
    );
    expect(r.mismatches.map((m) => m.field)).toEqual(["color.bg"]);
  });

  test("an allowance narrowed to ios does not cover android", () => {
    const ios = manifestOf({
      version: 1,
      colors: [{ web: "#ff0000", native: "#f50a05", platform: "ios" }],
    });
    const mk = (p: ParityPlatform) =>
      compare(
        side("web", null, { button: colored("#ff0000") }),
        side(p, 3, { button: colored("#f50a05") }),
        ios,
      );
    expect(mk("ios").mismatches).toEqual([]);
    expect(mk("android").mismatches).toHaveLength(1);
  });
});

describe("declared differences", () => {
  const declared = manifestOf({
    version: 1,
    differences: {
      "Button/md-primary": { button: { android: { "box.h": 40 }, web: { "box.h": 38 } } },
    },
  });

  test("a declared difference passes", () => {
    const r = compare(
      side("web", null, { button: h(38) }),
      side("android", 3, { button: h(40) }),
      declared,
    );
    expect(r.mismatches).toEqual([]);
    expect(r.declared).toHaveLength(1);
    expect(staleDeclarations([r])).toEqual([]);
  });

  test("a side that left its declared value is a mismatch and a stale declaration", () => {
    const r = compare(
      side("web", null, { button: h(38) }),
      side("android", 3, { button: h(42) }),
      declared,
    );
    expect(r.mismatches).toHaveLength(1);
    expect(staleDeclarations([r])).toEqual([
      expect.objectContaining({
        sentence: "stale declaration: Button/md-primary button box.h: android is 42, declared 40",
      }),
    ]);
  });

  test("a stale declaration where both sides agree now is reported and does not drift", () => {
    const r = compare(
      side("web", null, { button: h(40) }),
      side("android", 3, { button: h(40) }),
      declared,
    );
    expect(r.mismatches).toEqual([]);
    expect(staleDeclarations([r]).map((s) => s.sentence)).toEqual([
      "stale declaration: Button/md-primary button box.h: both sides agree now (40)",
    ]);
  });

  test("a declaration that applies in any pair of the build is not stale", () => {
    const applied = compare(
      side("web", null, { button: h(38) }),
      side("android", 3, { button: h(40) }),
      declared,
    );
    const agreed = compare(
      side("web", null, { button: h(40) }),
      side("ios", 3, { button: h(40) }),
      declared,
    );
    expect(staleDeclarations([applied, agreed])).toEqual([]);
  });

  test("a key with a theme covers only that theme", () => {
    const themed = manifestOf({
      version: 1,
      differences: {
        "Button/md-primary light": { button: { android: { "box.h": 40 }, web: { "box.h": 38 } } },
      },
    });
    const r = compare(
      side("web", null, { button: h(38) }),
      side("android", 3, { button: h(40) }),
      themed,
    );
    expect(r.mismatches).toHaveLength(1);
  });
});

describe("parseParityManifest", () => {
  test("names the field it refuses", () => {
    expect(() => manifestOf({ version: 2 })).toThrow("m.version must be 1");
    expect(() => manifestOf({ version: 1, colors: [{ web: "red", native: "#000000" }] })).toThrow(
      "m.colors[0].web must be lowercase",
    );
    expect(() =>
      manifestOf({ version: 1, differences: { A: { p: { windows: { gap: 1 } } } } }),
    ).toThrow('m.differences["A"]["p"].windows is not a platform');
    expect(() =>
      manifestOf({
        version: 1,
        differences: { A: { p: { web: { gap: 1 }, android: { bogus: 1 } } } },
      }),
    ).toThrow("is not a metrics field");
    expect(() =>
      manifestOf({ version: 1, differences: { A: { p: { web: { gap: 1 } } } } }),
    ).toThrow("declares gap for web only");
    expect(() => manifestOf({ version: 1, extra: 1 })).toThrow("m.extra is not a known key");
  });
});
