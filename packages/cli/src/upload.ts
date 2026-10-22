import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CaptureSession,
  DEFAULT_FLAKE_RETRIES,
  type Fingerprint,
  type Shoot,
  type SnapshotEntry,
  UploadError,
  type UploadResult,
  UsageError,
  findConfigIfAny,
  fontSetHash,
  imageId,
  loadConfig,
  openCaptureSession,
  recapture,
  uploadSnapshots,
  type UploadDeps,
} from "@pixelslash/engine";
import { RemoteError } from "./api.ts";
import { readFlags } from "./args.ts";
import { connect, resolveProject } from "./remote.ts";
import type { Io } from "./run.ts";

export const UPLOAD_USAGE =
  "pixelslash upload DIR [--server URL] [--token-path PATH] [--project ID|NAME] [--base BRANCH] [--branch NAME] [--pr N] [--config FILE] [--flake-retries N]\nThe token is --token-path, PIXELSLASH_TOKEN, or the one `pixelslash login` stored. The server is --server, PIXELSLASH_SERVER, or `upload.server` in the config.\nA shot that differs from its baseline is captured again --flake-retries times (else `flake.retries` in the config, else 2; 0 turns it off), through the config's routes.";

/** The flags `upload` and `capture --upload` share. */
export const UPLOAD_FLAGS = [
  "server",
  "token-path",
  "project",
  "base",
  "branch",
  "pr",
  "config",
  "flake-retries",
] as const;

export type UploadFlags = Partial<Record<(typeof UPLOAD_FLAGS)[number], string>>;

function prNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError("--pr must be a positive integer");
  return n;
}

function flakeRetries(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n))
    throw new UsageError("--flake-retries must be a non-negative integer");
  return n;
}

type Target = { server: string; token: string; baseBranch: string; projectId?: string };

/**
 * Where to send and as whom, resolved as every remote command does. A personal token reaches
 * several projects, so it also names one; a CI token's project is its own.
 */
async function resolveTarget(flags: UploadFlags, deps: UploadDeps, cwd: string): Promise<Target> {
  const remote = await connect(flags, { ...deps, cwd });
  const { server } = remote.client;
  const { token } = remote;
  const baseBranch = flags.base ?? remote.upload?.baseBranch ?? "main";
  if (!token.startsWith("psu_")) return { server, token, baseBranch };
  try {
    const project = await resolveProject(remote, flags.project);
    return { server, token, baseBranch, projectId: project.id };
  } catch (e) {
    // `upload` keeps exit 1 for a server that refused it, whichever request it refused.
    if (e instanceof RemoteError) throw new UploadError(e.message);
    throw e;
  }
}

type OwnRecapture = {
  retries: number;
  recapture: (e: SnapshotEntry) => Promise<Shoot | undefined>;
  close: () => Promise<void>;
};

/** What of `e`'s fingerprint this machine does not share; `browser` is known once it is open. */
function differs(e: SnapshotEntry, here: Partial<Fingerprint>): string[] {
  return (["image", "browser", "fonts"] as const).filter(
    (k) => here[k] !== undefined && here[k] !== e.fingerprint[k],
  );
}

function sameMachine(e: SnapshotEntry, here: Partial<Fingerprint>): void {
  const differ = differs(e, here);
  if (differ.length > 0)
    throw new Error(`it was captured with a different ${differ.join(", ")} than this machine`);
}

/**
 * `upload DIR`'s re-capture, through the config it finds. A shot captured by a different image or
 * font set than this machine's is refused before a browser opens (its runs would differ for that
 * alone); the browser is opened the first time a shot needs it, and its version checked then.
 */
async function configRecapture(
  flags: UploadFlags,
  cwd: string,
  warn: (m: string) => void,
  env: NodeJS.ProcessEnv,
): Promise<OwnRecapture | undefined> {
  const path = findConfigIfAny(flags.config, cwd);
  if (!path) return undefined;
  const config = await loadConfig(path);
  let local: Promise<string> | undefined;
  let opening: Promise<CaptureSession> | undefined;
  return {
    retries: config.flake.retries,
    recapture: async (e) => {
      sameMachine(e, { image: imageId(env), fonts: await (local ??= fontSetHash()) });
      const session = await (opening ??= openCaptureSession(config, { warn }));
      sameMachine(e, session.fingerprint);
      return recapture(session, e);
    },
    close: async () => {
      if (opening) await (await opening.catch(() => undefined))?.close();
    },
  };
}

/** `--flake-retries 0` or the caller's own re-capture opens nothing; else the config found. */
async function chooseRecapture(
  flags: UploadFlags,
  deps: UploadDeps,
  warn: (m: string) => void,
): Promise<OwnRecapture | undefined> {
  if (deps.recapture || flakeRetries(flags["flake-retries"]) === 0) return undefined;
  const cwd = deps.cwd ?? process.cwd();
  const own = await configRecapture(flags, cwd, warn, deps.env ?? process.env);
  if (!own && flags["flake-retries"] !== undefined)
    warn("warning: no config found, so changed shots are not captured again");
  return own;
}

function printFlakes(result: UploadResult, io: Io): void {
  for (const { entry, record } of result.flaky) {
    const { width, height } = entry.variant.viewport;
    io.stdout.write(
      `flaky: ${entry.name} (${width}x${height} ${entry.variant.theme}): ${record.differed.length} of ${record.runs} runs differed; policy ${record.policy}\n`,
    );
  }
  if (result.report) io.stdout.write(`report: ${pathToFileURL(result.report).href}\n`);
}

/**
 * Send `dir` to the server the flags, env or config name. Returns the exit code (0): a flaky
 * shot is said and sent, and what it does to the build is the server's call. `deps.recapture` is
 * the caller's own re-capture (`capture --upload`); without one, the config found is opened when
 * a shot needs it. `--flake-retries 0` opens nothing.
 */
export async function uploadDir(
  dir: string,
  flags: UploadFlags,
  io: Io,
  deps: UploadDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const warn = (m: string) => io.stderr.write(`${m}\n`);
  const retries = flakeRetries(flags["flake-retries"]);
  const target = await resolveTarget(flags, deps, cwd);
  const own = await chooseRecapture(flags, deps, warn);
  try {
    const result = await uploadSnapshots(
      {
        dir: resolve(dir),
        server: target.server,
        token: target.token,
        projectId: target.projectId,
        flakeRetries: retries ?? own?.retries ?? DEFAULT_FLAKE_RETRIES,
        git: {
          cwd,
          baseBranch: target.baseBranch,
          branch: flags.branch,
          pr: prNumber(flags.pr),
        },
      },
      { ...deps, warn, ...(own && { recapture: own.recapture }) },
    );
    const { commitSha, branch } = result.git;
    io.stdout.write(`pixelslash: uploaded ${result.snapshots} snapshots\n`);
    io.stdout.write(`build: ${result.buildId} (${commitSha.slice(0, 7)} on ${branch})\n`);
    printFlakes(result, io);
    return 0;
  } finally {
    await own?.close();
  }
}

/** `--flag value` pairs for exactly the flags in `keys`. */
export function readFlagPairs<K extends string>(
  argv: string[],
  keys: readonly K[],
): Partial<Record<K, string>> {
  const flags: Partial<Record<K, string>> = {};
  for (const [name, val] of readFlags(argv)) {
    const key = keys.find((k) => k === name);
    if (!key) throw new UsageError(`unexpected argument: --${name}`);
    flags[key] = val;
  }
  return flags;
}

/** `pixelslash upload DIR`. */
export async function runUpload(argv: string[], io: Io, deps: UploadDeps = {}): Promise<number> {
  const [dir, ...rest] = argv;
  if (!dir || dir.startsWith("--")) throw new UsageError("need a snapshot DIR");
  return uploadDir(dir, readFlagPairs(rest, UPLOAD_FLAGS), io, deps);
}
