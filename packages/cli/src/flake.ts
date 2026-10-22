import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CaptureConfig,
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
  renderReproReport,
  resolveDiff,
  suggestFixes,
} from "@pixelslash/engine";
import { RemoteError, isObj, objects, str } from "./api.ts";
import { readFlagPairs, takeJson } from "./args.ts";
import { askTerminal, previewEdits, printResolved, printRun } from "./flake-print.ts";
import { REMOTE_FLAGS, connect, resolveProject, type Remote, type RemoteDeps } from "./remote.ts";
import type { Io } from "./run.ts";
import { type Watch, watched } from "./watch.ts";

/**
 * `pixelslash flakes` and `pixelslash flake <id>` (ob 1725): the project's open flakes, and the
 * local loop for fixing one. The server is only read, and told a flake is resolved when asked;
 * no shot leaves the machine.
 */

/** A shot that still renders differently from itself. 1 is new violations, 3 to 5 are remote. */
export const UNSTABLE_EXIT = 6;

const REMOTE = "[--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE]";
export const FLAKES_USAGE = `pixelslash flakes ${REMOTE} [--json]\nThe open flakes.`;
export const FLAKE_USAGE = `pixelslash flake ID [--runs N] [--out DIR] [--write | --suggest] [--resolve [--note TEXT]] [--json] ${REMOTE}\nCaptures the flake's shot --runs times (default 5) through the config, against a baseUrl that is already up, and diffs each run with the first. Exit 0 stable, ${UNSTABLE_EXIT} unstable.\n--write offers the suggested config changes and writes the one you pick (JSON configs only). --suggest shows exactly what each would set and writes nothing. --resolve marks the flake resolved on the server when this run is stable. --json prints the run (or with --suggest, the changes) as JSON, as the MCP tools return it.`;

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
  deps: { warn: (m: string) => void; watch: Watch },
): Promise<{ shots: Shoot[]; route: Route; variant: Variant }> {
  const opened = await openCaptureSession(config, { warn: deps.warn });
  const session = watched(opened, deps.watch, runs);
  try {
    const { route, variant } = shotOf(f, config, session.routes);
    const shots: Shoot[] = [];
    for (let i = 0; i < runs; i++) shots.push(await session.shoot(route, variant));
    return { shots, route, variant };
  } finally {
    await session.close();
  }
}

/** The runs, each differing run's overlay and `report.html` into `out`; returns their paths. */
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
  return { report, files, overlays };
}

/** `--resolve`: only a stable run resolves a flake, so a fix is seen to work before it is said to. */
async function resolveIfStable(
  remote: Remote,
  { id, note, stable }: { id: string; note: string | undefined; stable: boolean },
): Promise<boolean> {
  if (!stable) return false;
  const reply = await remote.client.post(`/api/v1/flakes/${encodeURIComponent(id)}/resolve`, {
    ...(note !== undefined && { note }),
  });
  const flake = reply.body.flake;
  if (!isObj(flake) || flake.status !== "resolved")
    throw new RemoteError(
      `POST /api/v1/flakes/${id}/resolve: the flake is not resolved in the answer`,
    );
  return true;
}

function flakeArgs(argv: string[]) {
  const [id, ...more] = argv;
  if (!id || id.startsWith("--"))
    throw new UsageError("need a flake ID (`pixelslash flakes` lists them)");
  const { json, rest } = takeJson(more);
  const [resolving, write, suggest] = [
    rest.includes("--resolve"),
    rest.includes("--write"),
    rest.includes("--suggest"),
  ];
  const flags = readFlagPairs(
    rest.filter((a) => !SWITCHES.has(a)),
    FLAKE_FLAGS,
  );
  checkNote(flags.note, resolving);
  if (write && (json || suggest))
    throw new UsageError("--write asks at the terminal: not with --json or --suggest");
  if (suggest && resolving) throw new UsageError("--suggest does not go with --resolve");
  return { id, flags, write, suggest, json, resolving, runs: parseRuns(flags.runs) };
}

const SWITCHES = new Set(["--write", "--resolve", "--suggest"]);
const FLAKE_FLAGS = [...REMOTE_FLAGS, "project", "runs", "out", "note"] as const;
export type FlakeFlags = Partial<Record<(typeof FLAKE_FLAGS)[number], string>>;

/** `--note` goes with `--resolve`, and is at most 200 characters. */
export function checkNote(note: string | undefined, resolving: boolean): void {
  if (note !== undefined && !resolving) throw new UsageError("--note goes with --resolve");
  if (note !== undefined && note.length > MAX_NOTE)
    throw new UsageError(`--note is at most ${MAX_NOTE} characters`);
}

/** One flake reproduced here: what was captured, what the engine measured, what to change. */
export type FlakeRun = {
  id: string;
  flake: Flake;
  remote: Remote;
  configPath: string;
  config: CaptureConfig;
  repro: Repro;
  fixes: Suggestion[];
  out: string;
  report: string;
  files: Record<number, string>;
  overlays: Record<number, string>;
};

/** Capture the flake's shot `runs` times here and measure it; the server is only read. */
export async function reproduceFlake(
  id: string,
  flags: FlakeFlags,
  deps: RemoteDeps & { warn: (m: string) => void; watch?: Watch; started?: (line: string) => void },
): Promise<FlakeRun> {
  const runs = parseRuns(flags.runs);
  const cwd = deps.cwd ?? process.cwd();
  const configPath = findConfig(flags.config, cwd);
  const config = await loadConfig(configPath);
  const remote = await connect(flags, { ...deps, cwd });
  const { project, flakes } = await flakesOf(remote, flags.project);
  const flake = flakes.find((f) => f.id === id);
  if (!flake) throw new RemoteError(`no flake ${id} in ${project.name}`);
  deps.started?.(
    `flake ${id}: ${key(flake)}, ${str(flake.status)}; capturing it ${runs} times here`,
  );
  const watch = deps.watch ?? {};
  const { shots, route, variant } = await captureRuns(config, flake, runs, {
    warn: deps.warn,
    watch,
  });
  const repro = measureRepro(shots, resolveDiff(config, route, variant));
  const fixes = suggestFixes(repro, config, route, variant);
  const out = resolve(cwd, flags.out ?? "pixelslash-flake");
  const written = await writeRuns(out, { title: key(flake), repro, shots, fixes });
  return { id, flake, remote, configPath, config, repro, fixes, out, ...written };
}

/** Resolve the flake on the server when the run was stable; false, and nothing sent, when not. */
export const resolveFlake = (r: FlakeRun, note: string | undefined) =>
  resolveIfStable(r.remote, { id: r.id, note, stable: r.repro.stable });

const flakeKey = (f: Flake) => ({
  id: str(f.id),
  name: str(f.name),
  browser: str(f.browser),
  viewport: str(f.viewport),
  theme: str(f.theme),
  status: str(f.status),
});

/** `--json` and `check_flake` / `resolve_flake`: every run, what differed, what to change. */
export function flakeJson(r: FlakeRun, resolved: boolean | null) {
  const { repro } = r;
  return {
    flake: flakeKey(r.flake),
    measured: "local",
    uploaded: false,
    stable: repro.stable,
    differed: repro.differed,
    area: repro.area ?? null,
    runs: repro.runs.map(({ overlay: _overlay, ...run }) => ({
      ...run,
      file: join(r.out, r.files[run.run] ?? ""),
      overlay: r.overlays[run.run] ? join(r.out, r.overlays[run.run] ?? "") : null,
    })),
    suggestions: r.fixes.map((s, i) => ({ n: i + 1, text: s.text, edit: s.edit ?? null })),
    report: r.report,
    resolved,
  };
}

/** `--suggest --json` and `suggest_ignore`: the config changes, as the user would make them. */
export async function suggestJson(r: FlakeRun) {
  const { raw, previews } = await previewEdits(r.configPath, r.config, r.fixes);
  return {
    flake: flakeKey(r.flake),
    stable: r.repro.stable,
    config: r.configPath,
    editable: raw !== undefined,
    written: false,
    edits: previews,
    report: r.report,
  };
}

/** `pixelslash flake ID`: reproduce one flake here, say what differs and what to change. */
export async function runFlake(argv: string[], io: Io, deps: FlakeDeps = {}): Promise<number> {
  const { id, flags, write, suggest, json, resolving } = flakeArgs(argv);
  const r = await reproduceFlake(id, flags, {
    ...deps,
    warn: (m) => io.stderr.write(`${m}\n`),
    started: (line) => (json ? io.stderr : io.stdout).write(`${line}\n`),
  });
  const code = r.repro.stable ? 0 : UNSTABLE_EXIT;
  if (json) {
    const resolved = resolving ? await resolveFlake(r, flags.note) : null;
    const out = suggest ? await suggestJson(r) : flakeJson(r, resolved);
    io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return code;
  }
  await printRun(r, { suggest, write }, io, deps.ask ?? askTerminal);
  if (resolving) printResolved(r, await resolveFlake(r, flags.note), io);
  return code;
}
