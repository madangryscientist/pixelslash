import { resolve } from "node:path";
import {
  UsageError,
  findConfigIfAny,
  loadConfig,
  resolveToken,
  uploadSnapshots,
  type UploadDeps,
} from "@pixelslash/engine";
import { readFlags } from "./args.ts";
import type { Io } from "./run.ts";

export const UPLOAD_USAGE =
  "pixelslash upload DIR [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N] [--config FILE]\nThe token is PIXELSLASH_TOKEN or --token-path. The server is --server, PIXELSLASH_SERVER, or `upload.server` in the config.";

/** The flags `upload` and `capture --upload` share. */
export const UPLOAD_FLAGS = ["server", "token-path", "base", "branch", "pr", "config"] as const;

export type UploadFlags = Partial<Record<(typeof UPLOAD_FLAGS)[number], string>>;

function prNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError("--pr must be a positive integer");
  return n;
}

type Target = { server: string; token: string; baseBranch: string };

/** Where to send and as whom: flags first, then env, then the config if there is one. */
async function resolveTarget(
  flags: UploadFlags,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Target> {
  const configPath = findConfigIfAny(flags.config, cwd);
  const upload = configPath ? (await loadConfig(configPath)).upload : undefined;
  const server = flags.server ?? env.PIXELSLASH_SERVER ?? upload?.server;
  if (!server)
    throw new UsageError("need --server URL, PIXELSLASH_SERVER, or upload.server in the config");
  const tokenPath = flags["token-path"];
  const token = await resolveToken(
    tokenPath ? resolve(tokenPath) : undefined,
    env,
    "PIXELSLASH_TOKEN",
  );
  return { server, token, baseBranch: flags.base ?? upload?.baseBranch ?? "main" };
}

/** Send `dir` to the server the flags, env or config name. Returns the exit code (0). */
export async function uploadDir(
  dir: string,
  flags: UploadFlags,
  io: Io,
  deps: UploadDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const target = await resolveTarget(flags, deps.env ?? process.env, cwd);
  const result = await uploadSnapshots(
    {
      dir: resolve(dir),
      server: target.server,
      token: target.token,
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
