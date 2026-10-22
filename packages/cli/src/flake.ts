import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAUSE_WORDS,
  type CaptureConfig,
  type ConfigEdit,
  type Repro,
  type Route,
  type Shoot,
  type Suggestion,
  UsageError,
  type Variant,
  findConfig,
  loadConfig,
  measureRepro,
  openCaptureSession,
  parseConfig,
  renderReproReport,
  resolveDiff,
  suggestFixes,
} from "@pixelslash/engine";
import { firstLine } from "./account.ts";
import { RemoteError, isObj, objects, str } from "./api.ts";
import { readFlagPairs, takeJson } from "./args.ts";
import { REMOTE_FLAGS, connect, resolveProject, type Remote, type RemoteDeps } from "./remote.ts";
import type { Io } from "./run.ts";

/**
 * `pixelslash flakes` and `pixelslash flake <id>` (ob 1725): the project's open flakes, and the
 * local loop for fixing one. The server is only read, and told a flake is resolved when asked;
 * no shot leaves the machine.
 */

/** A shot that still renders differently from itself. 1 is new violations, 3 to 5 are remote. */
export const UNSTABLE_EXIT = 6;

const REMOTE = "[--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE]";
export const FLAKES_USAGE = `pixelslash flakes ${REMOTE} [--json]\nThe open flakes.`;
export const FLAKE_USAGE = `pixelslash flake ID [--runs N] [--out DIR] [--write] [--resolve [--note TEXT]] ${REMOTE}\nCaptures the flake's shot --runs times (default 5) through the config, against a baseUrl that is already up, and diffs each run with the first. Exit 0 stable, ${UNSTABLE_EXIT} unstable.\n--write offers the suggested config changes and writes the one you pick (JSON configs only). --resolve marks the flake resolved on the server when this run is stable.`;

const DEFAULT_RUNS = 5;
const MAX_NOTE = 200;

export type FlakeDeps = RemoteDeps & {
  /** Asks a question on the terminal and returns the answer; stdin by default. */
  ask?: (question: string) => Promise<string>;
};

type Flake = Record<string, unknown>;

async function flakesOf(remote: Remote, project: string | undefined) {
  const p = await resolveProject(remote, project);
  const reply = await remote.client.get(`/api/v1/projects/${encodeURIComponent(p.id)}/flakes`);
  return { project: p, reply, flakes: objects(reply.body.flakes) };
}

function key(f: Flake): string {
  return `${str(f.name)} (${str(f.browser)} ${str(f.viewport)} ${str(f.theme)})`;
}

/** `pixelslash flakes`: the project's open flakes. `--json` is the reply as sent. */
export async function runFlakes(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const { json, rest } = takeJson(argv);
  const flags = readFlagPairs(rest, [...REMOTE_FLAGS, "project"]);
  const remote = await connect(flags, deps);
  const { project, reply, flakes } = await flakesOf(remote, flags.project);
  if (json) {
    io.stdout.write(`${reply.text}\n`);
    return 0;
  }
  const shown = flakes.filter((f) => f.status === "open");
  if (shown.length === 0) {
    io.stdout.write(`no open flakes in ${project.name}\n`);
    return 0;
  }
  for (const f of shown) {
    const builds = Array.isArray(f.evidence) ? f.evidence.length : 0;
    io.stdout.write(
      `${str(f.id)}  ${key(f)}  ${builds} ${builds === 1 ? "build" : "builds"}  ${str(f.updated_at)}\n`,
    );
  }
  io.stdout.write("reproduce one locally: pixelslash flake ID\n");
  return 0;
}

function parseRuns(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUNS;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 2 || n > 50)
    throw new UsageError("--runs must be a whole number from 2 to 50");
  return n;
}

/** The config's route and variant for the flake's key; a usage error naming what is missing. */
function shotOf(
  f: Flake,
  config: CaptureConfig,
  routes: Route[],
): { route: Route; variant: Variant } {
  const route = routes.find((r) => r.name === str(f.name));
  if (!route) throw new UsageError(`the config has no route or story named "${str(f.name)}"`);
  const variant = config.variants.find(
    (v) =>
      v.browser === str(f.browser) &&
      `${v.viewport.width}x${v.viewport.height}` === str(f.viewport) &&
      v.theme === str(f.theme),
  );
  if (!variant)
    throw new UsageError(
      `the config has no variant for ${str(f.browser)} ${str(f.viewport)} ${str(f.theme)}`,
    );
  return { route, variant };
}

/** Capture the shot `runs` times, one after another, through one browser. */
async function captureRuns(
  config: CaptureConfig,
  f: Flake,
  runs: number,
  warn: (m: string) => void,
): Promise<{ shots: Shoot[]; route: Route; variant: Variant }> {
  const session = await openCaptureSession(config, { warn });
  try {
    const { route, variant } = shotOf(f, config, session.routes);
    const shots: Shoot[] = [];
    for (let i = 0; i < runs; i++) shots.push(await session.shoot(route, variant));
    return { shots, route, variant };
  } finally {
    await session.close();
  }
}

/** The runs, each differing run's overlay and `report.html` into `out`; returns the report. */
async function writeRuns(
  out: string,
  input: { title: string; repro: Repro; shots: Shoot[]; fixes: Suggestion[] },
) {
  const { title, repro, shots, fixes } = input;
  await rm(join(out, "runs"), { recursive: true, force: true });
  await mkdir(join(out, "runs"), { recursive: true });
  const files: Record<number, string> = {};
  const overlays: Record<number, string> = {};
  for (const [i, shot] of shots.entries()) {
    files[i + 1] = `runs/run${i + 1}.png`;
    await Bun.write(join(out, files[i + 1] ?? ""), shot.png);
  }
  for (const r of repro.runs) {
    if (!r.differed || !r.overlay) continue;
    overlays[r.run] = `runs/diff${r.run}.png`;
    await Bun.write(join(out, overlays[r.run] ?? ""), r.overlay);
  }
  const report = join(out, "report.html");
  await Bun.write(report, renderReproReport({ title, repro, suggestions: fixes, files, overlays }));
  return report;
}

function printRepro(repro: Repro, io: Io): void {
  for (const r of repro.runs.slice(1)) {
    const causes = r.causes.map((c) => CAUSE_WORDS[c]).join(", ");
    io.stdout.write(
      `run ${r.run}: ${r.differed ? "differed" : "same"}${causes ? ` (${causes})` : ""}\n`,
    );
    for (const g of r.regions)
      io.stdout.write(
        `  ${CAUSE_WORDS[g.kind]}: ${g.w}x${g.h} at ${g.x},${g.y} (${g.changedPixels} px)\n`,
      );
  }
  const n = repro.runs.length;
  io.stdout.write(
    repro.stable
      ? `stable: all ${n} runs rendered the same\n`
      : `unstable: ${repro.differed.length} of ${n - 1} runs differed from run 1\n`,
  );
}

function routeEntry(raw: Record<string, unknown>, config: CaptureConfig, name: string) {
  const i = config.routes.findIndex((r) => r.name === name);
  const routes = raw.routes;
  if (i < 0 || !Array.isArray(routes)) throw new UsageError(`the config has no route "${name}"`);
  const entry: unknown = routes[i];
  const obj = typeof entry === "string" ? { path: entry } : entry;
  if (!isObj(obj)) throw new UsageError(`config: routes[${i}] is not a route`);
  routes[i] = obj;
  return { where: `routes[${i}]`, entry: obj };
}

function child(parent: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = parent[k];
  const obj = isObj(v) ? v : {};
  parent[k] = obj;
  return obj;
}

/** Apply `edit` to the raw JSON config in place; returns what it set, in the config's own paths. */
function applyEdit(raw: Record<string, unknown>, config: CaptureConfig, edit: ConfigEdit): string {
  if (edit.kind === "stabilise") {
    child(raw, "stabilise")[edit.key] = edit.value;
    return `stabilise.${edit.key} = ${JSON.stringify(edit.value)}`;
  }
  const { where, entry } = routeEntry(raw, config, edit.route);
  if (edit.kind === "flaky-skip") {
    entry.flaky = "skip";
    return `${where}.flaky = "skip"`;
  }
  const layer = child(child(entry, "variants"), edit.variant);
  const ignore = Array.isArray(layer.ignore) ? layer.ignore : [];
  layer.ignore = [...ignore, edit.rect];
  return `${where}.variants.${edit.variant}.ignore += ${JSON.stringify(edit.rect)}`;
}

const askTerminal = async (question: string): Promise<string> => {
  if (!process.stdin.isTTY) return "";
  process.stderr.write(question);
  return firstLine();
};

/**
 * `--write`: list the suggestions that are config changes and write the one the user types, after
 * showing exactly what it sets. Nothing typed, or no terminal, writes nothing.
 */
async function offerEdits(
  target: { path: string; config: CaptureConfig; fixes: Suggestion[] },
  io: Io,
  ask: (q: string) => Promise<string>,
): Promise<void> {
  const { path, config, fixes } = target;
  const edits = fixes.flatMap((s, i) => (s.edit ? [{ n: i + 1, edit: s.edit }] : []));
  if (edits.length === 0) {
    io.stdout.write("--write: none of these is a config change; nothing written\n");
    return;
  }
  if (!path.endsWith(".json")) {
    io.stdout.write(`--write: ${path} is not JSON, so it is not edited; add the change by hand\n`);
    return;
  }
  const raw: unknown = JSON.parse(await Bun.file(path).text());
  if (!isObj(raw)) throw new UsageError(`config: ${path} is not an object`);
  const previews = edits.map(({ n, edit }) => {
    const copy = structuredClone(raw);
    return { n, edit, set: applyEdit(copy, config, edit) };
  });
  for (const p of previews) io.stdout.write(`  ${p.n}: ${p.set}\n`);
  const answer = (
    await ask(
      `Write which change to ${path}? It is rewritten as 2-space JSON. Type ${previews.map((p) => p.n).join(" or ")}, or nothing to leave it: `,
    )
  ).trim();
  const picked = previews.find((p) => String(p.n) === answer);
  if (!picked) {
    io.stdout.write(
      answer === "" ? "nothing written\n" : `"${answer}" is not one of them; nothing written\n`,
    );
    return;
  }
  applyEdit(raw, config, picked.edit);
  parseConfig(raw);
  await Bun.write(path, `${JSON.stringify(raw, null, 2)}\n`);
  io.stdout.write(
    `wrote ${picked.set} to ${path}; run \`pixelslash flake ID\` again to see if it holds\n`,
  );
}

/** `--resolve`: only a stable run resolves a flake, so a fix is seen to work before it is said to. */
async function resolveIfStable(
  remote: Remote,
  { id, note, stable }: { id: string; note: string | undefined; stable: boolean },
  io: Io,
) {
  if (!stable) {
    io.stdout.write("not resolved: the shot is still unstable here\n");
    return;
  }
  const reply = await remote.client.post(`/api/v1/flakes/${encodeURIComponent(id)}/resolve`, {
    ...(note !== undefined && { note }),
  });
  const flake = reply.body.flake;
  if (!isObj(flake) || flake.status !== "resolved")
    throw new RemoteError(
      `POST /api/v1/flakes/${id}/resolve: the flake is not resolved in the answer`,
    );
  io.stdout.write(`resolved ${id} on ${remote.client.server}\n`);
}

function flakeArgs(argv: string[]) {
  const [id, ...more] = argv;
  if (!id || id.startsWith("--"))
    throw new UsageError("need a flake ID (`pixelslash flakes` lists them)");
  const resolving = more.includes("--resolve");
  const flags = readFlagPairs(
    more.filter((a) => a !== "--write" && a !== "--resolve"),
    [...REMOTE_FLAGS, "project", "runs", "out", "note"],
  );
  if (flags.note !== undefined && !resolving) throw new UsageError("--note goes with --resolve");
  if (flags.note !== undefined && flags.note.length > MAX_NOTE)
    throw new UsageError(`--note is at most ${MAX_NOTE} characters`);
  return { id, flags, write: more.includes("--write"), resolving, runs: parseRuns(flags.runs) };
}

function printFixes(fixes: Suggestion[], report: string, io: Io): void {
  if (fixes.length > 0) io.stdout.write("what to change:\n");
  for (const [i, s] of fixes.entries())
    io.stdout.write(`  ${i + 1}. ${s.text}${s.edit ? " [--write]" : ""}\n`);
  io.stdout.write(`report: ${pathToFileURL(report).href}\n`);
}

/** `pixelslash flake ID`: reproduce one flake here, say what differs and what to change. */
export async function runFlake(argv: string[], io: Io, deps: FlakeDeps = {}): Promise<number> {
  const { id, flags, write, resolving, runs } = flakeArgs(argv);
  const cwd = deps.cwd ?? process.cwd();
  const configPath = findConfig(flags.config, cwd);
  const config = await loadConfig(configPath);
  const remote = await connect(flags, { ...deps, cwd });
  const { project, flakes } = await flakesOf(remote, flags.project);
  const flake = flakes.find((f) => f.id === id);
  if (!flake) throw new RemoteError(`no flake ${id} in ${project.name}`);
  const warn = (m: string) => io.stderr.write(`${m}\n`);
  io.stdout.write(
    `flake ${id}: ${key(flake)}, ${str(flake.status)}; capturing it ${runs} times here\n`,
  );
  const { shots, route, variant } = await captureRuns(config, flake, runs, warn);
  const repro = measureRepro(shots, resolveDiff(config, route, variant));
  const fixes = suggestFixes(repro, config, route, variant);
  const report = await writeRuns(resolve(cwd, flags.out ?? "pixelslash-flake"), {
    title: key(flake),
    repro,
    shots,
    fixes,
  });
  printRepro(repro, io);
  printFixes(fixes, report, io);
  if (!repro.stable && write)
    await offerEdits({ path: configPath, config, fixes }, io, deps.ask ?? askTerminal);
  if (resolving) await resolveIfStable(remote, { id, note: flags.note, stable: repro.stable }, io);
  return repro.stable ? 0 : UNSTABLE_EXIT;
}
