import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { capturePair, launchBrowser, shotPair, type CapturePage } from "./capture.ts";
import type { DiffOptions, IgnoreRect } from "./diff.ts";
import { UsageError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import {
  bunSpawn,
  judgePage,
  pngNames,
  resolveJudge,
  type SpawnProc,
  type Violation,
} from "./judge.ts";
import { renderIndex, renderPixelReport, renderReport, type RouteRow } from "./report.ts";
import { joinOrigin, routeSlug } from "./routes.ts";
import { writeRunFiles, writeRunTimings, type RunManifest } from "./run.ts";
import { withTimings } from "./report-timings.ts";
import { buildTimings, timed, type ShotTiming, type Timings } from "./timings.ts";

export type Deps = {
  spawn?: SpawnProc;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => string | null;
  capture?: CapturePage;
};

/** One comparison: a URL pair, a PNG pair or (with `routes`) PNG dirs, optionally judged against `ds`. */
export type CompareOptions = {
  live: string | undefined;
  local: string | undefined;
  livePng: string | undefined;
  localPng: string | undefined;
  livePngDir: string | undefined;
  localPngDir: string | undefined;
  routes: string[] | undefined;
  ds: string | undefined;
  out: string;
  width: number;
  label: string | undefined;
  /** Diff options for this run; keys left out take the engine default. */
  diff: DiffOptions;
  /** Areas (image px) skipped by the diff in both shots and hatched in the report. */
  ignore: IgnoreRect[];
};

export type CompareResult = {
  already: Violation[];
  fresh: Violation[];
  reportPath: string;
  skipped: boolean;
  manifest?: RunManifest;
  out: string;
  changedPixels?: number;
  /** Where the time went (ob 1791): also in `manifest.json` and the report. */
  timings?: Timings;
};

type Verdict = { already: Violation[]; fresh: Violation[]; skipped: boolean };

export async function compareRoutes(opts: CompareOptions, deps: Deps = {}): Promise<CompareResult> {
  const started = performance.now();
  const routes = opts.routes ?? [];
  const pixel = !opts.ds;
  await mkdir(opts.out, { recursive: true });
  const browser = await routeBrowser(opts, deps);
  const rows: RouteRow[] = [];
  const shots: ShotTiming[] = [];
  const already: Violation[] = [];
  const fresh: Violation[] = [];
  let skipped = false;
  try {
    for (const path of routes) {
      const slug = routeSlug(path);
      const one = await compare(routeOptions(opts, path, slug), deps, browser, path);
      rows.push(routeRow(path, slug, one));
      shots.push(...(one.timings?.shots ?? []));
      already.push(...one.already);
      fresh.push(...one.fresh);
      skipped = one.skipped;
    }
  } finally {
    await browser?.close();
  }
  const reportPath = join(opts.out, "index.html");
  const timings = buildTimings(started, shots);
  await Bun.write(reportPath, withTimings(renderIndex(rows, pixel), timings));
  const result: CompareResult = { already, fresh, reportPath, skipped, out: opts.out, timings };
  if (pixel) result.changedPixels = rows.reduce((n, r) => n + r.changedPixels, 0);
  return result;
}

function routeBrowser(opts: CompareOptions, deps: Deps): Promise<Browser | undefined> | undefined {
  return opts.live && opts.local && !deps.capture ? launchBrowser() : undefined;
}

function routeRow(path: string, slug: string, one: CompareResult): RouteRow {
  return {
    path,
    slug,
    already: one.already.length,
    fresh: one.fresh.length,
    skipped: one.skipped,
    changedPixels: one.manifest?.changedPixels ?? 0,
  };
}

function routeOptions(opts: CompareOptions, path: string, slug: string): CompareOptions {
  return {
    ...opts,
    live: opts.live ? joinOrigin(opts.live, path) : undefined,
    local: opts.local ? joinOrigin(opts.local, path) : undefined,
    livePng: opts.livePngDir ? join(opts.livePngDir, `${slug}.png`) : undefined,
    localPng: opts.localPngDir ? join(opts.localPngDir, `${slug}.png`) : undefined,
    routes: undefined,
    out: join(opts.out, slug),
  };
}

async function dsComponents(ds: string): Promise<string[]> {
  if (!existsSync(ds)) throw new UsageError(`ds dir not found: ${ds}`);
  const components = await pngNames(ds);
  if (components.length === 0) throw new UsageError(`no png rasters in ${ds}`);
  return components;
}

async function takeShots(
  opts: CompareOptions,
  deps: Deps,
  browser: Browser | undefined,
): Promise<void> {
  const liveDest = join(opts.out, "live.png");
  const localDest = join(opts.out, "local.png");
  if (opts.livePng && opts.localPng) {
    if (!existsSync(opts.livePng)) throw new UsageError(`live-png not found: ${opts.livePng}`);
    if (!existsSync(opts.localPng)) throw new UsageError(`local-png not found: ${opts.localPng}`);
    await copyFile(opts.livePng, liveDest);
    await copyFile(opts.localPng, localDest);
    return;
  }
  if (!opts.live || !opts.local) throw new UsageError("need --live URL --local URL");
  const pair = { liveUrl: opts.live, localUrl: opts.local, liveDest, localDest };
  if (browser) await shotPair(browser, pair, opts.width);
  else await capturePair(pair, opts.width, deps.capture);
}

async function judgePair(
  out: string,
  ds: string,
  components: string[],
  deps: Deps,
): Promise<Verdict> {
  const kind = resolveJudge(deps);
  if (kind == null) return { already: [], fresh: [], skipped: true };
  const input = { dsDir: ds, components, spawn: deps.spawn ?? bunSpawn, kind };
  const already = await judgePage(join(out, "live.png"), input);
  const localHits = await judgePage(join(out, "local.png"), input);
  const liveNames = new Set(already.map((v) => v.component));
  return { already, fresh: localHits.filter((v) => !liveNames.has(v.component)), skipped: false };
}

export async function compare(
  opts: CompareOptions,
  deps: Deps = {},
  browser?: Browser,
  routePath?: string,
): Promise<CompareResult> {
  const started = performance.now();
  const components = opts.ds ? await dsComponents(opts.ds) : [];

  await mkdir(opts.out, { recursive: true });
  const captured = await timed(() => takeShots(opts, deps, browser));

  const main = Buffer.from(await Bun.file(join(opts.out, "live.png")).arrayBuffer());
  const branch = Buffer.from(await Bun.file(join(opts.out, "local.png")).arrayBuffer());
  const written = await writeRunFiles(opts.out, {
    main,
    branch,
    label: opts.label,
    diff: opts.diff,
    ignore: { main: opts.ignore, branch: opts.ignore },
  });
  const manifest = written.manifest;
  const shot: ShotTiming = { name: routePath ?? "page", diffMs: written.diffMs };
  // Existing PNGs are only copied: no capture happened, so no capture timing.
  if (!(opts.livePng && opts.localPng)) shot.captureMs = captured.ms;

  const reportPath = join(opts.out, "report.html");
  if (!opts.ds) {
    const timings = buildTimings(started, [shot]);
    const html = renderPixelReport({
      path: routePath,
      changedPixels: manifest.changedPixels,
      changed: manifest.changed,
      diff: opts.diff,
      regions: manifest.regions,
      specks: manifest.specks,
      ignoredPixels: manifest.ignoredPixels,
      ignored: manifest.ignored,
      main: written.main,
      branch: written.branch,
    });
    await Bun.write(reportPath, withTimings(html, timings));
    await writeRunTimings(opts.out, manifest, timings);
    return {
      already: [],
      fresh: [],
      reportPath,
      skipped: false,
      manifest,
      out: opts.out,
      timings,
    };
  }

  const ds = opts.ds;
  const judged = await timed(() => judgePair(opts.out, ds, components, deps));
  const verdict = judged.value;
  // A run with no judge has no judge timing, not 0.
  if (!verdict.skipped) shot.judgeMs = judged.ms;
  const timings = buildTimings(started, [shot]);
  const dsOut = join(opts.out, "ds");
  await mkdir(dsOut, { recursive: true });
  for (const name of components) {
    await copyFile(join(opts.ds, name), join(dsOut, name));
  }
  await Bun.write(
    reportPath,
    withTimings(
      renderReport({ already: verdict.already, fresh: verdict.fresh, components }),
      timings,
    ),
  );
  await writeRunTimings(opts.out, manifest, timings);
  return { ...verdict, reportPath, manifest, out: opts.out, timings };
}
