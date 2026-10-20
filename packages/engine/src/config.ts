import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { UsageError } from "./errors.ts";
import { routeSlug } from "./routes.ts";

/** The browsers the pinned capture image ships. A variant naming another is a usage error. */
export const IMAGE_BROWSERS = ["chromium"] as const;
export type BrowserName = (typeof IMAGE_BROWSERS)[number];
export type Theme = "light" | "dark";

/** A rectangle in full-page CSS px; scaled by the device scale factor when painted. */
export type MaskRect = { x: number; y: number; width: number; height: number };
/** A CSS selector (every match is blanked) or a fixed rectangle. */
export type Mask = string | MaskRect;

export type Variant = {
  name: string;
  browser: BrowserName;
  viewport: { width: number; height: number };
  theme: Theme;
};

export type Route = { path: string; name: string; masks: Mask[]; tags: string[] };

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

export type StartCommand = { command: string; readyUrl: string; timeoutMs: number };

export type CaptureConfig = {
  baseUrl: string;
  start: StartCommand | undefined;
  routes: Route[];
  variants: Variant[];
  stabilise: Stabilise;
};

export const CONFIG_NAMES = [
  "pixelslash.config.ts",
  "pixelslash.config.js",
  "pixelslash.config.mjs",
  "pixelslash.config.json",
];

const DEFAULT_STABILISE: Stabilise = {
  animations: true,
  caret: true,
  clock: "2026-01-01T00:00:00.000Z",
  timers: true,
  deviceScaleFactor: 1,
  timeoutMs: 8_000,
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(where: string, what: string): never {
  throw new UsageError(`config: ${where} ${what}`);
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v === "") bad(where, "must be a non-empty string");
  return v;
}

function posInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    bad(where, "must be a positive integer");
  return v;
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) bad(where, "must be an array of strings");
  return v.map((s, i) => str(s, `${where}[${i}]`));
}

function list(v: unknown, where: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) bad(where, "must be an array");
  return v;
}

function mask(v: unknown, where: string): Mask {
  if (typeof v === "string") return str(v, where);
  if (!isObj(v)) bad(where, "must be a CSS selector or { x, y, width, height }");
  const coord = (k: string) => {
    const n = v[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
      bad(`${where}.${k}`, "must be a non-negative integer");
    return n;
  };
  return {
    x: coord("x"),
    y: coord("y"),
    width: posInt(v.width, `${where}.width`),
    height: posInt(v.height, `${where}.height`),
  };
}

/** A route or variant name: it becomes a path segment in the snapshot dir. */
function fileName(v: unknown, where: string, fallback: string): string {
  const name = v === undefined ? fallback : str(v, where);
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || /^\.+$/.test(name))
    bad(where, "may only use letters, digits, _ . -");
  return name;
}

function clock(v: unknown): string | false {
  if (v === false) return false;
  if (v === undefined) return DEFAULT_STABILISE.clock;
  const iso = str(v, "stabilise.clock");
  if (Number.isNaN(Date.parse(iso))) bad("stabilise.clock", "must be an ISO date or false");
  return iso;
}

function timers(v: unknown, fixedClock: string | false): boolean {
  if (v === undefined) return fixedClock !== false;
  if (typeof v !== "boolean") bad("stabilise.timers", "must be true or false");
  if (v && fixedClock === false)
    bad("stabilise.timers", "needs a clock to pause: set stabilise.clock, or timers: false");
  return v;
}

function route(v: unknown, i: number, global: { masks: Mask[]; tags: string[] }): Route {
  const where = `routes[${i}]`;
  const r = typeof v === "string" ? { path: v } : v;
  if (!isObj(r)) bad(where, "must be a path or { path, name?, masks?, tags? }");
  const path = str(r.path, `${where}.path`);
  if (!path.startsWith("/")) bad(`${where}.path`, "must start with /");
  const name = fileName(r.name, `${where}.name`, routeSlug(path));
  return {
    path,
    name,
    masks: [
      ...global.masks,
      ...list(r.masks, `${where}.masks`).map((m, j) => mask(m, `${where}.masks[${j}]`)),
    ],
    tags: [...new Set([...global.tags, ...strings(r.tags, `${where}.tags`)])],
  };
}

function variant(v: unknown, i: number): Variant {
  const where = `variants[${i}]`;
  if (!isObj(v)) bad(where, "must be an object");
  const vp = v.viewport ?? { width: 1280, height: 720 };
  if (!isObj(vp)) bad(`${where}.viewport`, "must be { width, height }");
  const viewport = {
    width: posInt(vp.width, `${where}.viewport.width`),
    height: posInt(vp.height, `${where}.viewport.height`),
  };
  const theme = v.theme ?? "light";
  if (theme !== "light" && theme !== "dark") bad(`${where}.theme`, 'must be "light" or "dark"');
  const browser = v.browser ?? "chromium";
  if (!IMAGE_BROWSERS.some((b) => b === browser))
    bad(`${where}.browser`, `must be one the image ships: ${IMAGE_BROWSERS.join(", ")}`);
  const fallback = `chromium-${viewport.width}x${viewport.height}-${theme}`;
  return {
    name: fileName(v.name, `${where}.name`, fallback),
    browser: "chromium",
    viewport,
    theme,
  };
}

function stabilise(v: unknown): Stabilise {
  if (v === undefined) return { ...DEFAULT_STABILISE };
  if (!isObj(v)) bad("stabilise", "must be an object");
  const s = { ...DEFAULT_STABILISE };
  for (const key of ["animations", "caret"] as const) {
    const flag = v[key];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") bad(`stabilise.${key}`, "must be true or false");
    s[key] = flag;
  }
  s.clock = clock(v.clock);
  s.timers = timers(v.timers, s.clock);
  if (v.deviceScaleFactor !== undefined)
    s.deviceScaleFactor = posInt(v.deviceScaleFactor, "stabilise.deviceScaleFactor");
  if (v.timeoutMs !== undefined) s.timeoutMs = posInt(v.timeoutMs, "stabilise.timeoutMs");
  return s;
}

function start(v: unknown, baseUrl: string): StartCommand | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) bad("start", "must be { command, readyUrl?, timeoutMs? }");
  return {
    command: str(v.command, "start.command"),
    readyUrl: v.readyUrl === undefined ? baseUrl : str(v.readyUrl, "start.readyUrl"),
    timeoutMs: v.timeoutMs === undefined ? 60_000 : posInt(v.timeoutMs, "start.timeoutMs"),
  };
}

function uniqueNames(items: { name: string }[], what: string): void {
  const seen = new Set<string>();
  for (const { name } of items) {
    if (seen.has(name)) bad(what, `has two entries named "${name}"`);
    seen.add(name);
  }
}

/** Validate a raw config object and fill every default. */
export function parseConfig(raw: unknown): CaptureConfig {
  if (!isObj(raw)) bad("file", "must hold an object");
  const baseUrl = str(raw.baseUrl, "baseUrl");
  if (!URL.canParse(baseUrl)) bad("baseUrl", "must be a URL");
  const global = {
    masks: list(raw.masks, "masks").map((m, i) => mask(m, `masks[${i}]`)),
    tags: strings(raw.tags, "tags"),
  };
  const routes = list(raw.routes, "routes").map((r, i) => route(r, i, global));
  if (routes.length === 0) bad("routes", "must list at least one path");
  const rawVariants = list(raw.variants, "variants");
  const variants = (rawVariants.length === 0 ? [{}] : rawVariants).map(variant);
  uniqueNames(routes, "routes");
  uniqueNames(variants, "variants");
  return {
    baseUrl,
    start: start(raw.start, baseUrl),
    routes,
    variants,
    stabilise: stabilise(raw.stabilise),
  };
}

/** Find the config: `explicit` if given, else the first `pixelslash.config.*` in `cwd`. */
export function findConfig(explicit: string | undefined, cwd: string): string {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new UsageError(`config not found: ${path}`);
    return path;
  }
  const found = CONFIG_NAMES.map((n) => join(cwd, n)).find((p) => existsSync(p));
  if (!found) throw new UsageError(`no config: need --config FILE or ${CONFIG_NAMES.join(" / ")}`);
  return found;
}

/** Read a JSON config, or import a JS/TS one (its default export). */
export async function loadConfig(path: string): Promise<CaptureConfig> {
  if (extname(path) === ".json") {
    let raw: unknown;
    try {
      raw = JSON.parse(await Bun.file(path).text());
    } catch (e) {
      throw new UsageError(
        `config: ${path} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return parseConfig(raw);
  }
  const mod: unknown = await import(path);
  return parseConfig(isObj(mod) ? mod.default : undefined);
}
