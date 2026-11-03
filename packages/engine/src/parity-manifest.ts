import type { Fail } from "./diff-options.ts";

/**
 * The parity manifest (PS-296): a JSON file in the repo that says which differences between twin
 * snapshots are on purpose. The contract is `docs/metrics.md`. No runtime imports, like
 * `metrics-entry.ts`, so the CLI and later the server read the one shape.
 */

export const PARITY_MANIFEST_VERSION = 1;

export const PARITY_PLATFORMS = ["web", "android", "ios"] as const;
export type ParityPlatform = (typeof PARITY_PLATFORMS)[number];

export const LENGTH_FIELDS = [
  "box.x",
  "box.y",
  "box.w",
  "box.h",
  "padding.top",
  "padding.right",
  "padding.bottom",
  "padding.left",
  "gap",
  "font.lineHeight",
] as const;
/** Compared for equality, never within a tolerance. */
export const EXACT_FIELDS = ["font.size", "font.weight"] as const;
export const COLOR_FIELDS = ["color.fg", "color.bg", "color.border"] as const;

export const PARITY_FIELDS = [...LENGTH_FIELDS, ...EXACT_FIELDS, ...COLOR_FIELDS] as const;
export type ParityField = (typeof PARITY_FIELDS)[number];

export const isColorField = (f: ParityField): boolean => COLOR_FIELDS.some((c) => c === f);

export type ParityValue = number | string;

/** One allowed colour pair: this web value may be that native value. */
export type ColorAllowance = { web: string; native: string; platform?: "android" | "ios" };

/** What one part is declared to be on each platform, per field. */
export type Declaration = {
  /** The key as written: a snapshot name, or `<name> <theme>`. It matches a pair by that text. */
  key: string;
  part: string;
  platforms: Partial<Record<ParityPlatform, Partial<Record<ParityField, ParityValue>>>>;
};

export type ParityManifest = {
  version: typeof PARITY_MANIFEST_VERSION;
  colors: ColorAllowance[];
  differences: Declaration[];
};

export const EMPTY_MANIFEST: ParityManifest = {
  version: PARITY_MANIFEST_VERSION,
  colors: [],
  differences: [],
};

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

function object(v: unknown, where: string, fail: Fail): object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "must be an object");
  return v;
}

function allowed(o: object, keys: readonly string[], where: string, fail: Fail): void {
  for (const k of Object.keys(o))
    if (!keys.includes(k)) fail(`${where}.${k}`, "is not a known key");
}

function hex(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || !HEX.test(v)) fail(where, "must be lowercase #rrggbb or #rrggbbaa");
  return v;
}

function colors(raw: unknown, where: string, fail: Fail): ColorAllowance[] {
  if (!Array.isArray(raw)) return fail(where, "must be an array of {web, native} pairs");
  return raw.map((entry: unknown, i): ColorAllowance => {
    const at = `${where}[${i}]`;
    const o = object(entry, at, fail);
    allowed(o, ["web", "native", "platform"], at, fail);
    const platform: unknown = Reflect.get(o, "platform");
    if (platform !== undefined && platform !== "android" && platform !== "ios")
      fail(`${at}.platform`, 'must be "android" or "ios"');
    return {
      web: hex(Reflect.get(o, "web"), `${at}.web`, fail),
      native: hex(Reflect.get(o, "native"), `${at}.native`, fail),
      ...(platform !== undefined && { platform }),
    };
  });
}

function fieldValue(field: ParityField, v: unknown, where: string, fail: Fail): ParityValue {
  if (isColorField(field)) return hex(v, where, fail);
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    fail(where, "must be a number, 0 or more");
  return v;
}

function fieldValues(
  raw: unknown,
  at: string,
  fail: Fail,
): Partial<Record<ParityField, ParityValue>> {
  const fields = object(raw, at, fail);
  const values: Partial<Record<ParityField, ParityValue>> = {};
  for (const name of Object.keys(fields)) {
    const f = PARITY_FIELDS.find((x) => x === name);
    if (!f) return fail(`${at}.${name}`, `is not a metrics field (${PARITY_FIELDS.join(", ")})`);
    values[f] = fieldValue(f, Reflect.get(fields, name), `${at}.${name}`, fail);
  }
  return values;
}

function platformValues(raw: unknown, at: string, fail: Fail): Declaration["platforms"] {
  const byPlatform = object(raw, at, fail);
  const platforms: Declaration["platforms"] = {};
  for (const platform of Object.keys(byPlatform)) {
    const p = PARITY_PLATFORMS.find((x) => x === platform);
    if (!p) return fail(`${at}.${platform}`, `is not a platform (${PARITY_PLATFORMS.join(", ")})`);
    platforms[p] = fieldValues(Reflect.get(byPlatform, platform), `${at}.${platform}`, fail);
  }
  // A field on one platform only would be silently ignored: a difference needs both sides.
  for (const f of PARITY_FIELDS) {
    const on = PARITY_PLATFORMS.filter((x) => platforms[x]?.[f] !== undefined);
    if (on.length === 1)
      fail(
        at,
        `declares ${f} for ${on[0]} only; a declared difference needs the value on each side`,
      );
  }
  return platforms;
}

function declarations(raw: unknown, where: string, fail: Fail): Declaration[] {
  const byKey = object(raw, where, fail);
  return Object.keys(byKey).flatMap((key) => {
    const at = `${where}[${JSON.stringify(key)}]`;
    if (key.trim() === "") fail(at, "the snapshot name must not be empty");
    const parts = object(Reflect.get(byKey, key), at, fail);
    return Object.keys(parts).map((part) => ({
      key,
      part,
      platforms: platformValues(Reflect.get(parts, part), `${at}[${JSON.stringify(part)}]`, fail),
    }));
  });
}

/**
 * Reads a manifest. `fail` throws; the CLI passes one that names the file and the field.
 */
export function parseParityManifest(v: unknown, where: string, fail: Fail): ParityManifest {
  const o = object(v, where, fail);
  allowed(o, ["version", "colors", "differences"], where, fail);
  if (Reflect.get(o, "version") !== PARITY_MANIFEST_VERSION)
    fail(`${where}.version`, `must be ${PARITY_MANIFEST_VERSION}`);
  const rawColors: unknown = Reflect.get(o, "colors");
  const rawDiffs: unknown = Reflect.get(o, "differences");
  return {
    version: PARITY_MANIFEST_VERSION,
    colors: rawColors === undefined ? [] : colors(rawColors, `${where}.colors`, fail),
    differences: rawDiffs === undefined ? [] : declarations(rawDiffs, `${where}.differences`, fail),
  };
}
