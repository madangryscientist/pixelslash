import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_BROWSER,
  CLIENT_VERSION,
  CaptureError,
  FigmaError,
  UploadError,
  UsageError,
  compare,
  compareRoutes,
  fetchFigmaRasters,
  loadRoutes,
  playwrightCli,
  resolveToken,
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
import { DEV_USAGE, runDev } from "./dev.ts";
import type { KeyInput } from "./dev-loop.ts";
import { FLAKE_USAGE, FLAKES_USAGE, runFlake, runFlakes } from "./flake.ts";
import { IMPORT_USAGE, runImport } from "./import.ts";
import { MCP_USAGE, runMcp } from "./mcp.ts";
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
  const link = `report: ${fileUrl(result.reportPath)}\n`;
  if (!cli.ds) {
    const px = result.changedPixels ?? result.manifest?.changedPixels ?? 0;
    io.stdout.write(`pixelslash: ${px} changed pixels\n${link}`);
    return 0;
  }
  if (result.skipped) {
    io.stdout.write(`skip: no judge\n${link}`);
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

/** `pixelslash install-browser`: the Chromium `capture` launches, by the Playwright it launches it with. */
async function installBrowser(io: Io, deps: CliDeps): Promise<number> {
  const spawn: SpawnProc = deps.spawn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
  const proc = spawn([process.execPath, playwrightCli(), "install", CAPTURE_BROWSER], {
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
  io.stderr.write(`pixelslash: installing ${CAPTURE_BROWSER} failed (exit ${code})\n`);
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
  { usage: string; run: (argv: string[], io: Io, deps: CliDeps) => Promise<number> }
> = {
  capture: { usage: CAPTURE_USAGE, run: runCapture },
  compare: { usage: COMPARE_USAGE, run: (argv, io) => runCompare(argv, io) },
  import: { usage: IMPORT_USAGE, run: (argv, io) => runImport(argv, io) },
  upload: { usage: UPLOAD_USAGE, run: runUpload },
  check: { usage: CHECK_USAGE, run: runCheck },
  dev: { usage: DEV_USAGE, run: runDev },
  "install-browser": {
    usage: "pixelslash install-browser",
    run: (_, io, deps) => installBrowser(io, deps),
  },
  login: { usage: LOGIN_USAGE, run: runLogin },
  logout: { usage: LOGOUT_USAGE, run: runLogout },
  whoami: { usage: WHOAMI_USAGE, run: runWhoami },
  builds: { usage: BUILDS_USAGE, run: runBuilds },
  build: { usage: BUILD_USAGE, run: runBuild },
  status: { usage: STATUS_USAGE, run: runStatus },
  mcp: { usage: MCP_USAGE, run: runMcp },
  flakes: { usage: FLAKES_USAGE, run: runFlakes },
  flake: { usage: FLAKE_USAGE, run: runFlake },
};

export async function run(argv: string[], io: Io = process, deps: CliDeps = {}): Promise<number> {
  if (argv[0] === "--version") {
    io.stdout.write(`pixelslash ${CLIENT_VERSION}\n`);
    return 0;
  }
  const command = COMMANDS[argv[0] ?? ""];
  if (command) return guarded(() => command.run(argv.slice(1), io, deps), io, command.usage);
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
  );
}

/**
 * Map the known errors to exit codes: usage 2, capture, Figma or upload 1, a remote command the
 * server refused or could not answer 3. Anything else is a bug and throws.
 */
async function guarded(work: () => Promise<number>, io: Io, usage: string): Promise<number> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${e.message}\n${usage}\n`);
      return 2;
    }
    if (e instanceof RemoteError) {
      io.stderr.write(`${e.message}\n`);
      return REMOTE_EXIT;
    }
    if (e instanceof CaptureError || e instanceof FigmaError || e instanceof UploadError) {
      io.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
