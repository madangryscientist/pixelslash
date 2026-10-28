import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_VERSION,
  INSTALL_NAMES,
  IMAGE_BROWSERS,
  CaptureError,
  FigmaError,
  UploadError,
  UsageError,
  compare,
  compareRoutes,
  fetchFigmaRasters,
  isBrowserName,
  loadRoutes,
  playwrightCli,
  resolveToken,
  timingLine,
  type BrowserName,
  type CompareResult,
  type Deps,
  type SnapshotDeps,
  type SpawnProc,
  type UploadDeps,
} from "@pixelslash/engine";
import {
  LOGIN_USAGE,
  LOGOUT_USAGE,
  WHOAMI_USAGE,
  runLogin,
  runLogout,
  runWhoami,
  type ReadSecret,
} from "./account.ts";
import { REMOTE_EXIT, RemoteError } from "./api.ts";
import { USAGE, parseArgs, type Cli } from "./args.ts";
import { BUILDS_USAGE, BUILD_USAGE, runBuild, runBuilds } from "./builds.ts";
import { CAPTURE_USAGE, runCapture } from "./capture.ts";
import { CHECK_USAGE, runCheck } from "./check.ts";
import { COMPARE_USAGE, runCompare } from "./compare.ts";
import {
  INTERNAL_EXIT,
  crashLines,
  inState,
  newState,
  type RunState,
  type Stage,
} from "./failure.ts";
import { reportToSentry } from "./sentry.ts";
import { DEV_USAGE, runDev } from "./dev.ts";
import type { KeyInput } from "./dev-loop.ts";
import { FLAKE_USAGE, FLAKES_USAGE, runFlake, runFlakes } from "./flake.ts";
import { PROJECT_USAGE, runProject } from "./project.ts";
import { IMPORT_USAGE, runImport } from "./import.ts";
import { INIT_USAGE, runInit } from "./init.ts";
import { MCP_USAGE } from "./mcp-usage.ts";
import { STATUS_USAGE, runStatus } from "./status.ts";
import { UPLOAD_USAGE, runUpload } from "./upload.ts";

export type Io = { stdout: { write(s: string): void }; stderr: { write(s: string): void } };

function fileUrl(path: string): string {
  return `file://${path}`;
}

/** `--file`: pull the Figma components into a temp dir and judge against that. */
async function figmaDs(cli: Cli, file: string, deps: Deps): Promise<string> {
  const token = await resolveToken(cli.tokenPath, deps.env ?? process.env);
  const dest = await mkdtemp(join(tmpdir(), "pixelslash-ds-"));
  try {
    await fetchFigmaRasters({
      fileKey: file,
      token,
      dest,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    });
  } catch (e) {
    await rm(dest, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

/** Print the run summary and return the exit code: 1 only on NEW violations on Branch. */
function report(cli: Cli, result: CompareResult, io: Io): number {
  const code = summary(cli, result, io);
  if (result.timings) io.stderr.write(`${timingLine(result.timings)}\n`);
  return code;
}

function summary(cli: Cli, result: CompareResult, io: Io): number {
  const link = `report: ${fileUrl(result.reportPath)}\n`;
  if (!cli.ds) {
    const px = result.changedPixels ?? result.manifest?.changedPixels ?? 0;
    io.stdout.write(`pixelslash: ${px} changed pixels\n${link}`);
    return 0;
  }
  if (result.skipped) {
    io.stdout.write(`skip: ${result.skipReason ?? "no judge"}\n${link}`);
    return 0;
  }
  const n = result.fresh.length;
  const names = result.fresh.map((v) => v.component).join(", ");
  const newBit = n === 0 ? "0 new" : `${n} new on branch (${names})`;
  io.stdout.write(`pixelslash: ${result.already.length} already on main, ${newBit}\n${link}`);
  return n === 0 ? 0 : 1;
}

export type CliDeps = Deps &
  SnapshotDeps &
  UploadDeps & {
    readSecret?: ReadSecret;
    /** `pixelslash dev`'s keys; stdin by default. */ keys?: KeyInput;
    /** `pixelslash flake --write`'s question; the terminal by default. */
    ask?: (question: string) => Promise<string>;
  };

/** The browsers named on `install-browser`'s line (`all` is the three); none named is Chromium. */
function installNames(argv: string[]): BrowserName[] {
  if (argv.includes("all")) return [...IMAGE_BROWSERS];
  const names = argv.map((a) => {
    if (!isBrowserName(a)) throw new UsageError(`install-browser: unknown browser ${a}`);
    return a;
  });
  return names.length === 0 ? ["chromium"] : [...new Set(names)];
}

/** `pixelslash install-browser [chromium|firefox|webkit|all]`: the browsers `capture` launches, by the Playwright it launches them with. */
async function installBrowser(argv: string[], io: Io, deps: CliDeps): Promise<number> {
  const targets = installNames(argv).map((n) => INSTALL_NAMES[n]);
  const spawn: SpawnProc = deps.spawn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
  const proc = spawn([process.execPath, playwrightCli(), "install", ...targets], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: INSTALL_TIMEOUT_MS,
  });
  const [, , code] = await Promise.all([
    relay(proc.stdout, io.stdout),
    relay(proc.stderr, io.stderr),
    proc.exited,
  ]);
  if (code === 0) return 0;
  io.stderr.write(`pixelslash: installing ${targets.join(" ")} failed (exit ${code})\n`);
  return REMOTE_EXIT;
}

const INSTALL_TIMEOUT_MS = 600_000;

/** Pass a child's output on as it comes, so a download shows its progress. */
async function relay(
  stream: ReadableStream<Uint8Array> | null,
  sink: { write(s: string): void },
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink.write(decoder.decode(chunk, { stream: true }));
}

const COMMANDS: Record<
  string,
  {
    usage: string;
    /** The stage a crash is put down to until the command says it has moved on. */
    stage?: Stage;
    run: (argv: string[], io: Io, deps: CliDeps) => Promise<number>;
  }
> = {
  init: { usage: INIT_USAGE, run: runInit },
  capture: { usage: CAPTURE_USAGE, stage: "capture", run: runCapture },
  compare: { usage: COMPARE_USAGE, stage: "compare", run: (argv, io) => runCompare(argv, io) },
  import: { usage: IMPORT_USAGE, run: (argv, io) => runImport(argv, io) },
  upload: { usage: UPLOAD_USAGE, stage: "upload", run: runUpload },
  check: { usage: CHECK_USAGE, run: runCheck },
  dev: { usage: DEV_USAGE, run: runDev },
  "install-browser": {
    usage: "pixelslash install-browser [chromium|firefox|webkit|all]",
    run: installBrowser,
  },
  login: { usage: LOGIN_USAGE, run: runLogin },
  logout: { usage: LOGOUT_USAGE, run: runLogout },
  whoami: { usage: WHOAMI_USAGE, run: runWhoami },
  builds: { usage: BUILDS_USAGE, run: runBuilds },
  build: { usage: BUILD_USAGE, run: runBuild },
  status: { usage: STATUS_USAGE, run: runStatus },
  // Loaded on demand: no other command may need the MCP SDK installed (ob 1767).
  mcp: {
    usage: MCP_USAGE,
    run: async (argv, io, deps) => (await import("./mcp.ts")).runMcp(argv, io, deps),
  },
  flakes: { usage: FLAKES_USAGE, run: runFlakes },
  flake: { usage: FLAKE_USAGE, run: runFlake },
  project: { usage: PROJECT_USAGE, run: runProject },
};

export async function run(argv: string[], io: Io = process, deps: CliDeps = {}): Promise<number> {
  if (argv[0] === "--version") {
    io.stdout.write(`pixelslash ${CLIENT_VERSION}\n`);
    return 0;
  }
  const command = COMMANDS[argv[0] ?? ""];
  if (command)
    return guarded(() => command.run(argv.slice(1), io, deps), io, command.usage, {
      name: argv[0] ?? "",
      stage: command.stage,
      env: deps.env ?? process.env,
    });
  return guarded(
    async () => {
      const cli = parseArgs(argv);
      if (cli.routesFile) cli.routes = await loadRoutes(cli.routesFile);
      const figma = cli.file ? await figmaDs(cli, cli.file, deps) : undefined;
      if (figma) cli.ds = figma;
      try {
        const result = cli.routes ? await compareRoutes(cli, deps) : await compare(cli, deps);
        return report(cli, result, io);
      } finally {
        // `compare` has already copied the rasters into `--out/ds`, so the temp dir is spent.
        if (figma) await rm(figma, { recursive: true, force: true });
      }
    },
    io,
    USAGE,
    { name: "compare", stage: "compare", env: deps.env ?? process.env },
  );
}

/** Only the `UPLOAD FAILED` runs of the known errors are Sentry's: a refused argument or a page that would not settle is the user's. */
async function reportUploadFailure(
  e: Error,
  command: { name: string; env: Record<string, string | undefined> },
  state: RunState,
): Promise<void> {
  if (!e.message.includes("UPLOAD FAILED:")) return;
  await reportToSentry(command.env, e, {
    kind: "upload",
    command: command.name,
    stage: state.stage,
  });
}

/**
 * Map the known errors to exit codes: usage 2, capture, Figma or upload 1, a remote command the
 * server refused or could not answer 3. Anything else is a bug (PS-223): one `FAILED` line, what
 * reached the server, the stack, and exit 7, so a runner can tell a crash from a verdict.
 * A crash and an `UPLOAD FAILED` run are also reported to Sentry when `PIXELSLASH_SENTRY_DSN` is
 * set (PS-227); a new-violations exit, a usage error and a capture or Figma failure are not.
 */
async function guarded(
  work: () => Promise<number>,
  io: Io,
  usage: string,
  command: { name: string; stage: Stage | undefined; env: Record<string, string | undefined> },
): Promise<number> {
  const state = newState(command.stage);
  try {
    return await inState(state, work);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${e.message}\n${usage}\n`);
      return 2;
    }
    if (e instanceof RemoteError) {
      io.stderr.write(`${e.message}\n`);
      await reportUploadFailure(e, command, state);
      return REMOTE_EXIT;
    }
    if (e instanceof CaptureError || e instanceof FigmaError || e instanceof UploadError) {
      io.stderr.write(`${e.message}\n`);
      await reportUploadFailure(e, command, state);
      return 1;
    }
    io.stderr.write(`${crashLines(command.name, e, state).join("\n")}\n`);
    await reportToSentry(command.env, e, {
      kind: "crash",
      command: command.name,
      stage: state.stage,
    });
    return INTERNAL_EXIT;
  }
}
