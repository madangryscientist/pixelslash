import { type CaptureConfig, type Variant, loadConfig, parseConfig } from "./config.ts";
import { UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import { isHttpUrl, joinOrigin, routeSlug } from "./routes.ts";
import type { CaptureSession } from "./snapshot.ts";

/**
 * What `pixelslash dev` shoots (ob 1740): one route or story of the config, or a bare `--url`,
 * in all of its variants unless `--viewport` / `--theme` narrow them. The dev server is never
 * started here (invariant 5): the config's `start` is dropped, and a URL that is down fails.
 */

export type DevTargetOptions = {
  /** A route or story name in the config; exclusive with `url`. */
  name?: string | undefined;
  url?: string | undefined;
  /** `WxH`, or a variant name. */
  viewport?: string | undefined;
  theme?: string | undefined;
};

/** A variant matches `--viewport` by its `WxH` or its name. */
function viewportMatches(v: Variant, want: string): boolean {
  return `${v.viewport.width}x${v.viewport.height}` === want || v.name === want;
}

function narrowVariants(variants: Variant[], opts: DevTargetOptions): Variant[] {
  const { viewport, theme } = opts;
  if (theme !== undefined && theme !== "light" && theme !== "dark")
    throw new UsageError(`--theme must be light or dark, not ${theme}`);
  const kept = variants.filter(
    (v) =>
      (viewport === undefined || viewportMatches(v, viewport)) &&
      (theme === undefined || v.theme === theme),
  );
  if (kept.length === 0) {
    const have = variants.map(
      (v) => `${v.name} (${v.viewport.width}x${v.viewport.height} ${v.theme})`,
    );
    throw new UsageError(
      `no variant matches ${[viewport, theme].filter(Boolean).join(" ")}; the config has ${have.join(", ")}`,
    );
  }
  return kept;
}

/** A `--url` as a one-route config: the base config's variants and settings, its routes replaced. */
function urlConfig(config: CaptureConfig, url: string): CaptureConfig {
  if (!isHttpUrl(url)) throw new UsageError(`--url must be an http(s) URL: ${url}`);
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  const route = {
    path,
    name: routeSlug(path),
    masks: [],
    ignore: [],
    tags: [],
    diff: {},
    variantDiff: {},
    variantIgnore: {},
  };
  return { ...config, baseUrl: u.origin, storybook: undefined, routes: [route] };
}

/** The config `pixelslash dev` opens its session with: no start command, the variants narrowed. */
export function devConfig(config: CaptureConfig, opts: DevTargetOptions): CaptureConfig {
  if (opts.url !== undefined && opts.name !== undefined)
    throw new UsageError("name a route or story, or give --url, not both");
  if (opts.url === undefined && opts.name === undefined)
    throw new UsageError("name a route or story from the config, or give --url");
  const base = opts.url === undefined ? config : urlConfig(config, opts.url);
  return { ...base, start: undefined, variants: narrowVariants(base.variants, opts) };
}

/**
 * The config a dev run starts from: the found one, or with none and a `--url`, the defaults on that
 * URL's origin. No config and no `--url` names nothing to shoot.
 */
export async function loadDevConfig(
  path: string | undefined,
  url: string | undefined,
): Promise<CaptureConfig> {
  if (path) return loadConfig(path);
  if (url === undefined || !isHttpUrl(url))
    throw new UsageError("no pixelslash config here: pass --config FILE, or --url URL");
  return parseConfig({ baseUrl: new URL(url).origin, routes: ["/"] });
}

/** The target's name: the route or story, or the `--url` route's slug. */
export function targetName(config: CaptureConfig, opts: DevTargetOptions): string {
  return opts.name ?? config.routes[0]?.name ?? "index";
}

/** The session with its routes cut to the target; an unknown name lists what there is. */
export function narrowSession(session: CaptureSession, name: string): CaptureSession {
  const route = session.routes.find((r) => r.name === name);
  if (!route) {
    const names = session.routes.map((r) => r.name);
    throw new UsageError(`no route or story named ${name} (have ${names.join(", ")})`);
  }
  return { ...session, routes: [route] };
}

/** The URL a target's route is shot at. */
export function targetUrl(config: CaptureConfig, name: string): string | undefined {
  const route = config.routes.find((r) => r.name === name);
  if (route) return joinOrigin(config.baseUrl, route.path);
  return config.storybook ? config.storybook.url : undefined;
}

/** A URL that does not answer fails now, before a browser opens: we do not start the app. */
export async function probeTarget(url: string, fetchFn: FetchLike = fetch): Promise<void> {
  try {
    await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(5000) });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new UsageError(
      `${url} is not answering (${why}); pixelslash dev does not start a dev server, start it first`,
    );
  }
}
