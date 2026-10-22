import type { Fail } from "./diff-options.ts";

export type Stabilise = {
  /** Playwright `animations: "disabled"`: finite animations jump to the end, infinite ones reset. */
  animations: boolean;
  /** Hide the text caret. */
  caret: boolean;
  /** Freeze `Date.now()` / `new Date()` at this instant, or `false` for the real clock. */
  clock: string | false;
  /**
   * Stop page timers (`setInterval` / `setTimeout`) so carousels and tickers are in the same state on
   * every capture. Needs a clock to pause, so it follows `clock`: on by default, off when `clock` is `false`.
   */
  timers: boolean;
  deviceScaleFactor: number;
  /** Bounds navigation and the settle (fonts, images, network idle, two frames). The settle itself is not optional. */
  timeoutMs: number;
};

const DEFAULT_STABILISE: Stabilise = {
  animations: true,
  caret: true,
  clock: "2026-01-01T00:00:00.000Z",
  timers: true,
  deviceScaleFactor: 1,
  timeoutMs: 8_000,
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || v === "") fail(where, "must be a non-empty string");
  return v;
}

function posInt(v: unknown, where: string, fail: Fail): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    fail(where, "must be a positive integer");
  return v;
}

function clock(v: unknown, fail: Fail): string | false {
  if (v === false) return false;
  if (v === undefined) return DEFAULT_STABILISE.clock;
  const iso = text(v, "stabilise.clock", fail);
  if (Number.isNaN(Date.parse(iso))) fail("stabilise.clock", "must be an ISO date or false");
  return iso;
}

function timers(v: unknown, fixedClock: string | false, fail: Fail): boolean {
  if (v === undefined) return fixedClock !== false;
  if (typeof v !== "boolean") fail("stabilise.timers", "must be true or false");
  if (v && fixedClock === false)
    fail("stabilise.timers", "needs a clock to pause: set stabilise.clock, or timers: false");
  return v;
}

/** The config's `stabilise`: every key optional, the rest from `DEFAULT_STABILISE`. */
export function parseStabilise(v: unknown, fail: Fail): Stabilise {
  if (v === undefined) return { ...DEFAULT_STABILISE };
  if (!isObj(v)) fail("stabilise", "must be an object");
  const s = { ...DEFAULT_STABILISE };
  for (const key of ["animations", "caret"] as const) {
    const flag = v[key];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") fail(`stabilise.${key}`, "must be true or false");
    s[key] = flag;
  }
  s.clock = clock(v.clock, fail);
  s.timers = timers(v.timers, s.clock, fail);
  if (v.deviceScaleFactor !== undefined)
    s.deviceScaleFactor = posInt(v.deviceScaleFactor, "stabilise.deviceScaleFactor", fail);
  if (v.timeoutMs !== undefined) s.timeoutMs = posInt(v.timeoutMs, "stabilise.timeoutMs", fail);
  return s;
}
