import type { Fail } from "./diff-options.ts";

/**
 * A snapshot's layout metrics file (PS-294), its typed parser and its builder. The contract is
 * `docs/metrics.md`. No runtime imports, so the web emitter, the CLI, the server and the review UI
 * all read the one shape.
 */

/** The version this reader knows. A higher minor is read as this; another major is refused. */
export const METRICS_MAJOR = 1;
export const METRICS_VERSION = `${METRICS_MAJOR}.0`;

/** A file is at most this many bytes and this many parts; a bigger one is refused, never truncated. */
export const MAX_METRICS_BYTES = 1024 * 1024;
export const MAX_METRICS_PARTS = 2000;
export const MAX_PART_NAME = 200;

/** The suffix of a metrics file: `<name>.metrics.json` beside `<name>.png`. */
export const METRICS_SUFFIX = ".metrics.json";

export type MetricsBox = { x: number; y: number; w: number; h: number };
export type MetricsSides = { top: number; right: number; bottom: number; left: number };
export type MetricsFont = { size: number; weight: number; lineHeight?: number };
export type MetricsColor = { fg?: string; bg?: string; border?: string };

export type MetricsPart = {
  box: MetricsBox;
  padding?: MetricsSides;
  gap?: number;
  font?: MetricsFont;
  color?: MetricsColor;
};

export type Metrics = {
  version: string;
  root: string;
  parts: Record<string, MetricsPart>;
};

/** Numbers are written and read at this many decimals. */
const DECIMALS = 100;

/** `12.345` is `12.35`; a whole number stays whole. */
export const round2 = (n: number): number => {
  const r = Math.round(n * DECIMALS) / DECIMALS;
  return Object.is(r, -0) ? 0 : r;
};

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

function num(v: unknown, where: string, fail: Fail, min: number | null = 0): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, "must be a finite number");
  if (min !== null && v < min) fail(where, `must be ${min} or more`);
  return round2(v);
}

function object(v: unknown, where: string, fail: Fail): object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "must be an object");
  return v;
}

function optional<T>(
  parent: object,
  key: string,
  where: string,
  read: (v: unknown, at: string) => T,
): { [k: string]: T } {
  const v: unknown = Reflect.get(parent, key);
  return v === undefined ? {} : { [key]: read(v, `${where}.${key}`) };
}

function colour(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || !HEX.test(v)) fail(where, "must be lowercase #rrggbb or #rrggbbaa");
  return v;
}

function part(v: unknown, where: string, fail: Fail): MetricsPart {
  const p = object(v, where, fail);
  const field = (o: object, key: string, at: string, min: number | null = 0) =>
    num(Reflect.get(o, key), `${at}.${key}`, fail, min);
  const boxAt = `${where}.box`;
  const rawBox: unknown = Reflect.get(p, "box");
  if (rawBox === undefined) fail(boxAt, "is required");
  const b = object(rawBox, boxAt, fail);
  // x and y are measured from the root's corner, so a part above or left of it is negative.
  const box: MetricsBox = {
    x: field(b, "x", boxAt, null),
    y: field(b, "y", boxAt, null),
    w: field(b, "w", boxAt),
    h: field(b, "h", boxAt),
  };
  return {
    box,
    ...optional(p, "padding", where, (raw, at): MetricsSides => {
      const o = object(raw, at, fail);
      return {
        top: field(o, "top", at),
        right: field(o, "right", at),
        bottom: field(o, "bottom", at),
        left: field(o, "left", at),
      };
    }),
    ...optional(p, "gap", where, (raw, at) => num(raw, at, fail)),
    ...optional(p, "font", where, (raw, at): MetricsFont => {
      const o = object(raw, at, fail);
      const size = field(o, "size", at);
      const weight = field(o, "weight", at);
      if (weight < 1 || weight > 1000) fail(`${at}.weight`, "must be 1 to 1000");
      const lineHeight: unknown = Reflect.get(o, "lineHeight");
      return {
        size,
        weight,
        ...(lineHeight !== undefined && { lineHeight: field(o, "lineHeight", at) }),
      };
    }),
    ...optional(p, "color", where, (raw, at): MetricsColor => {
      const o = object(raw, at, fail);
      const read = (key: "fg" | "bg" | "border") => {
        const c: unknown = Reflect.get(o, key);
        return c === undefined ? {} : { [key]: colour(c, `${at}.${key}`, fail) };
      };
      return { ...read("fg"), ...read("bg"), ...read("border") };
    }),
  };
}

/** The file's version as `major.minor`; a higher minor reads as itself, another major is refused. */
function versionOf(o: object, where: string, fail: Fail): string {
  const version: unknown = Reflect.get(o, "version");
  const m = typeof version === "string" ? VERSION.exec(version) : null;
  if (!m) return fail(`${where}.version`, 'must be a string like "1.0"');
  if (Number(m[1]) !== METRICS_MAJOR)
    fail(`${where}.version`, `is ${m[0]}, but only version ${METRICS_MAJOR}.x is read`);
  return `${m[1]}.${m[2]}`;
}

function partsOf(o: object, where: string, fail: Fail): Record<string, MetricsPart> {
  const rawParts = object(Reflect.get(o, "parts"), `${where}.parts`, fail);
  const names = Object.keys(rawParts);
  if (names.length === 0) fail(`${where}.parts`, "must have at least one part");
  if (names.length > MAX_METRICS_PARTS)
    fail(`${where}.parts`, `has ${names.length} parts; at most ${MAX_METRICS_PARTS} are kept`);
  const parts: Record<string, MetricsPart> = {};
  for (const name of names) {
    const at = `${where}.parts[${JSON.stringify(name)}]`;
    if (name === "" || name.length > MAX_PART_NAME)
      fail(at, `name must be 1 to ${MAX_PART_NAME} characters`);
    Object.defineProperty(parts, name, {
      value: part(Reflect.get(rawParts, name), at, fail),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return parts;
}

/**
 * A parsed metrics value, reduced to what this reader knows: unknown fields are dropped and a higher
 * minor version reads as this one. Anything malformed calls `fail(where, what)`.
 */
export function parseMetrics(v: unknown, where: string, fail: Fail): Metrics {
  const o = object(v, where, fail);
  const version = versionOf(o, where, fail);
  const parts = partsOf(o, where, fail);
  const root: unknown = Reflect.get(o, "root");
  if (typeof root !== "string" || !Object.hasOwn(parts, root))
    fail(`${where}.root`, "must name one of the parts");
  return { version, root, parts };
}

/**
 * The text of a metrics file: size-capped, JSON, then `parseMetrics`. `bytes` is the file's size
 * when the caller has it (a string's length undercounts non-ASCII).
 */
export function parseMetricsText(
  text: string,
  where: string,
  fail: Fail,
  bytes: number = text.length,
): Metrics {
  if (bytes > MAX_METRICS_BYTES)
    fail(where, `is ${bytes} bytes; a metrics file is at most ${MAX_METRICS_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(where, "is not valid JSON");
  }
  return parseMetrics(json, where, fail);
}

/**
 * The names for a list of parts in document order: the first of a name keeps it, the next are
 * `name#2`, `name#3`.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const taken = new Set(names);
  return names.map((n, i) => {
    if (names.indexOf(n) === i) return n;
    // A page that already has a part called `name#2` keeps it; the repeat takes the next free number.
    let count = seen.get(n) ?? 1;
    let candidate: string;
    do candidate = `${n}#${++count}`;
    while (taken.has(candidate));
    seen.set(n, count);
    taken.add(candidate);
    return candidate;
  });
}

/** The file's text as capture and the native emitters write it. */
export function metricsText(m: Metrics): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}
