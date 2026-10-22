import { resolve } from "node:path";
import { UploadError, UsageError, uploadSnapshots, type UploadDeps } from "@pixelslash/engine";
import { RemoteError } from "./api.ts";
import { readFlags } from "./args.ts";
import { connect, resolveProject } from "./remote.ts";
import type { Io } from "./run.ts";

export const UPLOAD_USAGE =
  "pixelslash upload DIR [--server URL] [--token-path PATH] [--project ID|NAME] [--base BRANCH] [--branch NAME] [--pr N] [--config FILE]\nThe token is --token-path, PIXELSLASH_TOKEN, or the one `pixelslash login` stored. The server is --server, PIXELSLASH_SERVER, or `upload.server` in the config.";

/** The flags `upload` and `capture --upload` share. */
export const UPLOAD_FLAGS = [
  "server",
  "token-path",
  "project",
  "base",
  "branch",
  "pr",
  "config",
] as const;

export type UploadFlags = Partial<Record<(typeof UPLOAD_FLAGS)[number], string>>;

function prNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError("--pr must be a positive integer");
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

/** Send `dir` to the server the flags, env or config name. Returns the exit code (0). */
export async function uploadDir(
  dir: string,
  flags: UploadFlags,
  io: Io,
  deps: UploadDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const target = await resolveTarget(flags, deps, cwd);
  const result = await uploadSnapshots(
    {
      dir: resolve(dir),
      server: target.server,
      token: target.token,
      projectId: target.projectId,
      git: {
        cwd,
        baseBranch: target.baseBranch,
        branch: flags.branch,
        pr: prNumber(flags.pr),
      },
    },
    { ...deps, warn: (m) => io.stderr.write(`${m}\n`) },
  );
  const { commitSha, branch } = result.git;
  io.stdout.write(`pixelslash: uploaded ${result.snapshots} snapshots\n`);
  io.stdout.write(`build: ${result.buildId} (${commitSha.slice(0, 7)} on ${branch})\n`);
  return 0;
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
