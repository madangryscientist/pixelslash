import {
  type DevIteration,
  type DevStore,
  UsageError,
  devStore,
  latestIteration,
  liveSession,
  pinIteration,
  readPins,
  unpinIteration,
  worktreeRoot,
} from "@hackcove/pixelslash-engine";
import { readFlagPairs, takeJson } from "./args.ts";
import { attachTo } from "./dev-attach.ts";
import { devLoop, devOnce } from "./dev-loop.ts";
import { devSpec, differencesLine } from "./dev-spec.ts";
import type { CliDeps, Io } from "./run.ts";

export const DEV_USAGE = `pixelslash dev [TARGET | --url URL] [--viewport WxH|NAME] [--theme light|dark] [--watch PATH]... [--against main] [--judge [--ds DIR]] [--refresh-refs] [--figma-token-path PATH] [--once] [--json] [--config FILE] [--server URL] [--token-path PATH] [--project ID|NAME] [--base BRANCH]
pixelslash dev latest [TARGET] [--json] | pixelslash dev pin [ID] [--json] | pixelslash dev unpin [ID] [--json]
pixelslash dev spec [TARGET] [--json] [--refresh-refs] [--viewport WxH|NAME] [--theme light|dark] [--figma-token-path PATH] [--config FILE]
Re-captures one route or story of the config (the app must already be up) on every save and diffs it with the previous iteration, a pin, or main's baselines. A target with features.<target> (a spec, reference PNGs or Figma frames) gets them on the live page beside the shot, and with --judge, a list of how the shot differs; never a score. Keys: r run, p pin, u unpin, m main/previous, f refetch refs, q quit. A second dev in the same worktree attaches to the first. Nothing is uploaded.`;

const FLAGS = [
  "url",
  "viewport",
  "theme",
  "against",
  "ds",
  "config",
  "server",
  "token-path",
  "project",
  "base",
  "figma-token-path",
] as const;

export type DevFlags = Partial<Record<(typeof FLAGS)[number], string>>;

export type DevArgs = {
  flags: DevFlags;
  target: string | undefined;
  watch: string[];
  once: boolean;
  judge: boolean;
  refreshRefs: boolean;
  json: boolean;
};

export type DevDeps = CliDeps;

const SWITCHES = new Set(["--once", "--judge", "--refresh-refs"]);

/** `--watch a,b` or a repeated `--watch a`. */
function watchValue(v: string | undefined): string[] {
  if (!v || v.startsWith("--")) throw new UsageError("missing value for --watch");
  return v.split(",").filter(Boolean);
}

/** Pull the switches, the repeatable `--watch`, and the one positional target out of `argv`. */
function splitArgs(argv: string[]): {
  pairs: string[];
  target: string | undefined;
  watch: string[];
  on: Set<string>;
} {
  const pairs: string[] = [];
  const watch: string[] = [];
  const on = new Set<string>();
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (SWITCHES.has(a)) on.add(a);
    else if (a === "--watch") watch.push(...watchValue(argv[++i]));
    else if (a.startsWith("--")) pairs.push(a, argv[++i] ?? "");
    else if (target === undefined) target = a;
    else throw new UsageError(`unexpected argument: ${a}`);
  }
  return { pairs, target, watch, on };
}

export function parseDevArgs(argv: string[]): DevArgs {
  const { json, rest } = takeJson(argv);
  const { pairs, target, watch, on } = splitArgs(rest);
  const flags = readFlagPairs(pairs, FLAGS);
  if (flags.against !== undefined && flags.against !== "main" && flags.against !== "previous")
    throw new UsageError(`--against must be main or previous, not ${flags.against}`);
  // Whether --judge has a --ds or a feature to judge against is known once the config is read.
  const judge = on.has("--judge");
  const refreshRefs = on.has("--refresh-refs");
  return { flags, target, watch, once: on.has("--once"), judge, refreshRefs, json };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function againstLabel(it: DevIteration): string {
  const a = it.against;
  if (a.kind === "main") return "main";
  if (a.kind === "none") return "nothing (first run)";
  return `${a.kind === "pin" ? "pin " : ""}#${Number(a.iteration)}`;
}

/** The terminal line per run: what changed, then our time apart from the page's settle. */
export function lineOf(it: DevIteration, url: string | null): string {
  const { changed, new: added, removed } = it.counts;
  const parts = [
    changed ? `${it.regions} regions changed · ${it.changedPixels} px` : "",
    added ? `${added} new` : "",
    removed ? `${removed} removed` : "",
  ].filter(Boolean);
  const what = parts.length > 0 ? parts.join(" · ") : "no change";
  const times = `ours ${secs(it.timings.oursMs)} · settle ${secs(it.timings.settleMs)}`;
  const tail = url ? ` · ${url}` : "";
  const note = it.note ? `\n  ${it.note}` : "";
  return `#${Number(it.id)} vs ${againstLabel(it)}: ${what} · ${times}${tail}${note}`;
}

/** `--json`: the iteration as stored (regions, pixels, timings, files, judge) and that nothing left. */
export function jsonOf(it: DevIteration, url: string | null): string {
  return JSON.stringify(iterationJson(it, url), null, 2);
}

/** What `--json` prints, before it is printed; `pixelslash mcp`'s dev tools answer the same. */
export function iterationJson(it: DevIteration, url: string | null) {
  return { uploaded: false, page: url, ...it };
}

/** `7` or `000007`: the store's six-digit id. */
const idOf = (raw: string | undefined) => (raw === undefined ? undefined : raw.padStart(6, "0"));

export async function storeOf(deps: DevDeps): Promise<DevStore> {
  return devStore(await worktreeRoot(deps.cwd ?? process.cwd()));
}

/** The latest iteration (of `target`, when named) and the live page, if a session is up. */
export async function latestOf(store: DevStore, target: string | undefined) {
  const it = await latestIteration(store, target);
  if (!it) return undefined;
  return { it, url: (await liveSession(store))?.url ?? null };
}

async function latest(argv: string[], io: Io, deps: DevDeps): Promise<number> {
  const { json, rest } = takeJson(argv);
  if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
  const found = await latestOf(await storeOf(deps), rest[0]);
  if (!found) {
    io.stderr.write(`pixelslash dev: no iteration yet${rest[0] ? ` of ${rest[0]}` : ""}\n`);
    return 1;
  }
  const { it, url } = found;
  io.stdout.write(`${json ? jsonOf(it, url) : lineOf(it, url)}\n`);
  if (!json && it.differences) io.stdout.write(`${differencesLine(it.differences)}\n`);
  return 0;
}

function pinLine(pin: boolean, id: string | undefined, pins: string[], asked: string | undefined) {
  const verb = pin ? "pinned" : "unpinned";
  if (id)
    return `${verb} #${Number(id)} (pins: ${pins.map((p) => `#${Number(p)}`).join(", ") || "none"})`;
  return `pixelslash dev: nothing to ${pin ? "pin" : "unpin"}${asked ? ` (#${asked})` : ""}`;
}

/** Pin or unpin `raw` (the latest, or the newest pin, when unset); `out` is the `--json`. */
export async function pinOf(store: DevStore, pin: boolean, raw: string | undefined) {
  const id = await (pin ? pinIteration : unpinIteration)(store, idOf(raw));
  const pins = await readPins(store);
  return { id, pins, out: { [pin ? "pinned" : "unpinned"]: id ?? null, pins } };
}

async function pinOrUnpin(pin: boolean, argv: string[], io: Io, deps: DevDeps): Promise<number> {
  const { json, rest } = takeJson(argv);
  if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
  const { id, pins, out } = await pinOf(await storeOf(deps), pin, rest[0]);
  if (json) io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else (id ? io.stdout : io.stderr).write(`${pinLine(pin, id, pins, rest[0])}\n`);
  return id ? 0 : 1;
}

/** `pixelslash dev` (ob 1740). */
export async function runDev(argv: string[], io: Io, deps: DevDeps = {}): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "latest") return latest(rest, io, deps);
  if (sub === "pin" || sub === "unpin") return pinOrUnpin(sub === "pin", rest, io, deps);
  if (sub === "spec") return devSpec(rest, (await storeOf(deps)).root, io, deps);
  const args = parseDevArgs(argv);
  const store = await storeOf(deps);
  const owner = await liveSession(store);
  if (owner) return attachTo(owner, args, io, deps);
  return args.once ? devOnce(store, args, io, deps) : devLoop(store, args, io, deps);
}
