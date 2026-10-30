import {
  type CaptureConfig,
  type DevDifferences,
  type DevFeature,
  type DevRef,
  type FeatureSource,
  UsageError,
  devConfig,
  findConfigIfAny,
  inlinePng,
  loadDevConfig,
  loadFeature,
  resolveToken,
} from "@hackcove/pixelslash-engine";
import { readFlagPairs, takeJson } from "./args.ts";
import type { DevArgs, DevDeps } from "./dev.ts";
import type { Io } from "./run.ts";

/**
 * A feature's spec and references in `pixelslash dev` (ob 1741): the Figma token, the target's
 * `features` entry made ready to resolve, the lines that say which refs were skipped and what the
 * judge listed, and `pixelslash dev spec`. None of it leaves the machine but a Figma fetch.
 */

/** `--figma-token-path` when given (a bad path fails), else `FIGMA_TOKEN`, else none. */
async function figmaToken(path: string | undefined, deps: DevDeps): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  if (path) return resolveToken(path, env);
  return env.FIGMA_TOKEN?.trim() || undefined;
}

/** The target's `features` entry with what resolving it needs; undefined when it has none. */
export async function featureSource(
  at: { config: CaptureConfig; target: string; root: string },
  flags: { "figma-token-path"?: string | undefined },
  deps: DevDeps,
): Promise<FeatureSource | undefined> {
  const { config, target, root } = at;
  const def = config.features[target];
  if (!def) return undefined;
  return {
    def,
    store: { root },
    variants: config.variants,
    dpr: config.stabilise.deviceScaleFactor,
    figma: {
      token: await figmaToken(flags["figma-token-path"], deps),
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    },
  };
}

/** `--judge` needs something to judge against: the design system, or the target's feature. */
export function checkJudge(args: DevArgs, feature: FeatureSource | undefined, target: string) {
  if (args.judge && !args.flags.ds && !feature)
    throw new UsageError(
      `--judge needs --ds DIR (the design system's rasters) or a features.${target} entry in the config`,
    );
}

/** A line per ref that has no file, said once per resolve and then carried on from. */
export function refLines(refs: DevRef[]): string[] {
  const out: string[] = [];
  for (const r of refs) {
    const line = `skip: ${r.skip} (${r.source})`;
    if (r.skip && !out.includes(line)) out.push(line);
  }
  return out;
}

/** What the judge listed against the spec and refs; never a verdict. */
export function differencesLine(d: DevDifferences): string {
  if (d.status === "skipped") return `skip: ${d.reason}`;
  if (d.status === "failed") return `judge failed: ${d.reason}`;
  const items = d.items.map(
    (i) =>
      `  ${i.n}. ${i.name} (${i.shot}): ${i.what} at ${i.area.x},${i.area.y} ${i.area.width}×${i.area.height}`,
  );
  return [`judge: ${d.items.length} differences from the spec and refs`, ...items].join("\n");
}

const SPEC_FLAGS = ["config", "viewport", "theme", "figma-token-path"] as const;

/** The target named, or the config's one feature when it has exactly one. */
function specTarget(config: CaptureConfig, named: string | undefined): string {
  if (named !== undefined) return named;
  const names = Object.keys(config.features);
  if (names.length === 1 && names[0] !== undefined) return names[0];
  throw new UsageError(
    names.length === 0
      ? "the config has no features entry; add features.<target>.spec or .refs"
      : `name a target: the config has features for ${names.join(", ")}`,
  );
}

/** `dev spec`'s argv: `--json`, `--refresh-refs`, the flags, and at most one target. */
function specArgs(argv: string[]) {
  const { json, rest } = takeJson(argv);
  const pairs: string[] = [];
  let named: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--refresh-refs") continue;
    if (a.startsWith("--")) pairs.push(a, rest[++i] ?? "");
    else if (named === undefined) named = a;
    else throw new UsageError(`unexpected argument: ${a}`);
  }
  const refresh = rest.includes("--refresh-refs");
  return { json, refresh, named, flags: readFlagPairs(pairs, SPEC_FLAGS) };
}

function writeSpecText(feature: DevFeature, io: Io) {
  io.stdout.write(`${feature.spec ? feature.spec.text : "(no spec)"}\n`);
  for (const r of feature.refs)
    io.stdout.write(`ref ${r.variant} ${r.viewport} ${r.theme}: ${r.file ?? `skip: ${r.skip}`}\n`);
}

/** `dev spec --json`: the refs inline, capped at 1024 px wide, so an agent need not open a file. */
export async function specJson(target: string, feature: DevFeature) {
  const refs = [];
  for (const r of feature.refs) refs.push({ ...r, image: r.file ? await inlinePng(r.file) : null });
  return { target, spec: feature.spec, refs };
}

type SpecFlags = Partial<Record<(typeof SPEC_FLAGS)[number], string | undefined>>;

/** The target's feature as it stands: the spec read now, the refs resolved. */
export async function specOf(
  at: { named: string | undefined; flags: SpecFlags; refresh: boolean; root: string },
  deps: DevDeps,
): Promise<{ target: string; feature: DevFeature }> {
  const { named, flags, refresh, root } = at;
  const base = await loadDevConfig(
    findConfigIfAny(flags.config, deps.cwd ?? process.cwd()),
    undefined,
  );
  const target = specTarget(base, named);
  const config = devConfig(base, { name: target, viewport: flags.viewport, theme: flags.theme });
  const src = await featureSource({ config, target, root }, flags, deps);
  if (!src) throw new UsageError(`the config has no features.${target} entry`);
  return { target, feature: await loadFeature(src, refresh) };
}

/** `pixelslash dev spec [TARGET]`: the spec text and the refs, as files and inline images. */
export async function devSpec(
  argv: string[],
  root: string,
  io: Io,
  deps: DevDeps,
): Promise<number> {
  const { json, refresh, named, flags } = specArgs(argv);
  const { target, feature } = await specOf({ named, flags, refresh, root }, deps);
  for (const line of refLines(feature.refs)) io.stderr.write(`${line}\n`);
  if (json) io.stdout.write(`${JSON.stringify(await specJson(target, feature), null, 2)}\n`);
  else writeSpecText(feature, io);
  return 0;
}
