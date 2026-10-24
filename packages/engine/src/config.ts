import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { parseArea, type Ignore, type Mask } from "./config-areas.ts";
import {
  type Feature,
  checkFeatureFiles,
  featuresBeside,
  parseFeatures,
} from "./config-feature.ts";
import { type CompositionConfig, parseComposition } from "./config-composition.ts";
import { type FlakyPolicy, parseFlake, parseFlaky } from "./config-flake.ts";
import { type Stabilise, parseStabilise } from "./config-stabilise.ts";
import { baseUrlOf, parseStorybook, type StorybookConfig } from "./config-storybook.ts";
import type { DiffOptions } from "./diff.ts";
import { mergeDiffOptions, parseDiffOptions } from "./diff-options.ts";
import { UsageError } from "./errors.ts";
import { isHttpUrl, routeSlug } from "./routes.ts";

/** The browsers the pinned capture image ships. A variant naming another is a usage error. */
export const IMAGE_BROWSERS = ["chromium"] as const;
export type BrowserName = (typeof IMAGE_BROWSERS)[number];
export type Theme = "light" | "dark";

export type { Ignore, Mask, MaskRect } from "./config-areas.ts";
export { type StorybookConfig } from "./config-storybook.ts";
export { DEFAULT_FLAKE_RETRIES, FLAKY_POLICIES, type FlakyPolicy } from "./config-flake.ts";
export { parseFlaky, resolveFlaky } from "./config-flake.ts";
export type { Stabilise } from "./config-stabilise.ts";
export type { Feature, FeatureRef } from "./config-feature.ts";
export type { CompositionConfig, CustomDeclared } from "./config-composition.ts";

export type Variant = {
  name: string;
  browser: BrowserName;
  viewport: { width: number; height: number };
  theme: Theme;
};

export type Route = {
  path: string;
  name: string;
  /** Redact: painted into the PNG at capture time. */
  masks: Mask[];
  /** This route's own ignore areas (a layer, not the resolved set; see `resolveIgnore`). */
  ignore: Ignore[];
  tags: string[];
  /** This route's own diff options (a layer, not the resolved set; see `resolveDiff`). */
  diff: DiffOptions;
  /** Per-variant diff options for this route, keyed by variant name. */
  variantDiff: Record<string, DiffOptions>;
  /** Per-variant ignore areas for this route, keyed by variant name. */
  variantIgnore: Record<string, Ignore[]>;
  /** This route's own flaky policy; unset takes the project's (see `resolveFlaky`). */
  flaky?: FlakyPolicy;
  /** Set on a route read from a Storybook index: its `path` is on `origin`, and capture waits for the story to render. */
  storybook?: { origin: string };
};

export type StartCommand = { command: string; readyUrl: string; timeoutMs: number };

/** Where `upload` sends builds, the merge-base branch, and the project a personal token means. */
export type UploadConfig = Record<"server" | "baseBranch" | "project", string | undefined>;

export type CaptureConfig = {
  baseUrl: string;
  start: StartCommand | undefined;
  /**
   * A module run once before the routes, after `start`, that can sign in (see `CaptureSetup`).
   * A path; `loadConfig` resolves it against the config file's directory.
   */
  setup: string | undefined;
  storybook: StorybookConfig | undefined;
  upload: UploadConfig;
  /** The project-wide diff options; routes and their variants layer over it. */
  diff: DiffOptions;
  /** The project-wide ignore areas; routes and their variants add to them. */
  ignore: Ignore[];
  /** The project-wide flaky policy; a route's (or a story's tag) wins. Unset is `"review"`. */
  flaky: FlakyPolicy | undefined;
  /** How many more times a shot that differs from its baseline is captured during an upload. */
  flake: { retries: number };
  /** The hand-written routes. Storybook's are read from the running Storybook at capture time (`storybookRoutes`). */
  routes: Route[];
  variants: Variant[];
  stabilise: Stabilise;
  /** What `pixelslash dev` builds a target against (ob 1741), keyed by route or story name. */
  features: Record<string, Feature>;
  /** Composition-only (ob 1850): every element styled outside this library is reported at capture. */
  composition: CompositionConfig | undefined;
};

export const CONFIG_NAMES = [
  "pixelslash.config.ts",
  "pixelslash.config.js",
  "pixelslash.config.mjs",
  "pixelslash.config.json",
];

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
  return parseArea(v, where, bad);
}

/** A route or variant name: it becomes a path segment in the snapshot dir. */
function fileName(v: unknown, where: string, fallback: string): string {
  const name = v === undefined ? fallback : str(v, where);
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || /^\.+$/.test(name))
    bad(where, "may only use letters, digits, _ . -");
  return name;
}

function diff(v: unknown, where: string): DiffOptions {
  return v === undefined ? {} : parseDiffOptions(v, where, bad);
}

function ignoreAreas(v: unknown, where: string): Ignore[] {
  return list(v, where).map((a, i) => mask(a, `${where}[${i}]`));
}

type VariantLayers = { diff: Record<string, DiffOptions>; ignore: Record<string, Ignore[]> };

/** The `diff` and `ignore` layers per variant name, read from `variants.<name>` in one pass. */
function variantLayers(v: unknown, where: string): VariantLayers {
  const out: VariantLayers = { diff: {}, ignore: {} };
  if (v === undefined) return out;
  if (!isObj(v)) bad(where, "must be an object keyed by variant name");
  for (const [name, entry] of Object.entries(v)) {
    if (!isObj(entry)) bad(`${where}.${name}`, "must be { diff?, ignore? }");
    for (const k of Object.keys(entry)) {
      if (k !== "diff" && k !== "ignore")
        bad(`${where}.${name}.${k}`, "is not a variant option (diff, ignore)");
    }
    out.diff[name] = diff(entry.diff, `${where}.${name}.diff`);
    out.ignore[name] = ignoreAreas(entry.ignore, `${where}.${name}.ignore`);
  }
  return out;
}

function route(v: unknown, i: number, global: { masks: Mask[]; tags: string[] }): Route {
  const where = `routes[${i}]`;
  const r = typeof v === "string" ? { path: v } : v;
  if (!isObj(r))
    bad(
      where,
      "must be a path or { path, name?, masks?, ignore?, tags?, diff?, variants?, flaky? }",
    );
  const path = str(r.path, `${where}.path`);
  if (!path.startsWith("/")) bad(`${where}.path`, "must start with /");
  const name = fileName(r.name, `${where}.name`, routeSlug(path));
  const variants = variantLayers(r.variants, `${where}.variants`);
  const flaky = parseFlaky(r.flaky, `${where}.flaky`, bad);
  return {
    path,
    name,
    masks: [
      ...global.masks,
      ...list(r.masks, `${where}.masks`).map((m, j) => mask(m, `${where}.masks[${j}]`)),
    ],
    ignore: ignoreAreas(r.ignore, `${where}.ignore`),
    tags: [...new Set([...global.tags, ...strings(r.tags, `${where}.tags`)])],
    diff: diff(r.diff, `${where}.diff`),
    variantDiff: variants.diff,
    variantIgnore: variants.ignore,
    ...(flaky && { flaky }),
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

function start(v: unknown, baseUrl: string): StartCommand | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) bad("start", "must be { command, readyUrl?, timeoutMs? }");
  return {
    command: str(v.command, "start.command"),
    readyUrl: v.readyUrl === undefined ? baseUrl : str(v.readyUrl, "start.readyUrl"),
    timeoutMs: v.timeoutMs === undefined ? 60_000 : posInt(v.timeoutMs, "start.timeoutMs"),
  };
}

function upload(v: unknown): UploadConfig {
  if (v === undefined) return { server: undefined, baseBranch: undefined, project: undefined };
  if (!isObj(v)) bad("upload", "must be { server?, baseBranch?, project? }");
  const server = v.server === undefined ? undefined : str(v.server, "upload.server");
  if (server !== undefined && !isHttpUrl(server)) bad("upload.server", "must be an http(s) URL");
  return {
    server,
    baseBranch: v.baseBranch === undefined ? undefined : str(v.baseBranch, "upload.baseBranch"),
    project: v.project === undefined ? undefined : str(v.project, "upload.project"),
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
  const global = {
    masks: list(raw.masks, "masks").map((m, i) => mask(m, `masks[${i}]`)),
    tags: strings(raw.tags, "tags"),
  };
  const sb = parseStorybook(raw.storybook, global, bad);
  const baseUrl = baseUrlOf(raw.baseUrl, sb, bad);
  const routes = list(raw.routes, "routes").map((r, i) => route(r, i, global));
  if (routes.length === 0 && !sb) bad("routes", "must list at least one path (or set storybook)");
  const rawVariants = list(raw.variants, "variants");
  const variants = (rawVariants.length === 0 ? [{}] : rawVariants).map(variant);
  uniqueNames(routes, "routes");
  uniqueNames(variants, "variants");
  for (const [i, r] of routes.entries()) {
    for (const name of Object.keys(r.variantDiff)) {
      if (!variants.some((vr) => vr.name === name))
        bad(
          `routes[${i}].variants.${name}`,
          `names no variant (have ${variants.map((vr) => vr.name).join(", ")})`,
        );
    }
  }
  return {
    baseUrl,
    start: start(raw.start, baseUrl),
    setup: raw.setup === undefined ? undefined : str(raw.setup, "setup"),
    storybook: sb,
    upload: upload(raw.upload),
    diff: diff(raw.diff, "diff"),
    ignore: ignoreAreas(raw.ignore, "ignore"),
    flaky: parseFlaky(raw.flaky, "flaky", bad),
    flake: parseFlake(raw.flake, bad),
    routes,
    variants,
    stabilise: parseStabilise(raw.stabilise, bad),
    features: parseFeatures(
      raw.features,
      variants.map((vr) => vr.name),
      bad,
    ),
    composition: parseComposition(raw.composition, bad),
  };
}

/**
 * The diff options a snapshot is compared with: variant > route > project > engine default.
 * Only keys someone set are in the result, so the engine default still applies to the rest.
 * The one place the layers are combined; a UI override layer goes on top here.
 */
export function resolveDiff(config: CaptureConfig, shot: Route, as: Variant): DiffOptions {
  return mergeDiffOptions(config.diff, shot.diff, shot.variantDiff[as.name] ?? {});
}

/**
 * The ignore areas a snapshot is captured with: project, then route, then variant, all added
 * together (an ignore area is something to skip, so a layer can only add). Selectors are resolved
 * to boxes in the page at capture time; rectangles are CSS px.
 */
export function resolveIgnore(config: CaptureConfig, shot: Route, as: Variant): Ignore[] {
  return [...config.ignore, ...shot.ignore, ...(shot.variantIgnore[as.name] ?? [])];
}

/** `findConfig`, but no config at all is `undefined`: `upload` runs fine without one. */
export function findConfigIfAny(explicit: string | undefined, cwd: string): string | undefined {
  if (explicit) return findConfig(explicit, cwd);
  return CONFIG_NAMES.map((n) => join(cwd, n)).find((p) => existsSync(p));
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

/** `loadConfig` for `dev`: the features' spec and PNG ref files must exist too, naming the config. */
export async function loadFeatureConfig(path: string): Promise<CaptureConfig> {
  const c = await loadConfig(path);
  checkFeatureFiles(c.features, (where, what) => bad(where, `${what} (config ${path})`));
  return c;
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
    return besideConfig(parseConfig(raw), path);
  }
  const mod: unknown = await import(path);
  return besideConfig(parseConfig(isObj(mod) ? mod.default : undefined), path);
}

/** A relative `setup`, spec or ref (and the composition library's lookup) is relative to the config file, not to wherever capture was run from. */
function besideConfig(c: CaptureConfig, path: string): CaptureConfig {
  return {
    ...c,
    features: featuresBeside(c.features, dirname(path)),
    ...(c.composition && { composition: { ...c.composition, from: dirname(path) } }),
    ...(c.setup !== undefined && { setup: resolve(dirname(path), c.setup) }),
  };
}
