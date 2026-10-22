import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CheckOptions,
  type CheckResult,
  type SnapshotDeps,
  type UploadDeps,
  UploadError,
  UsageError,
  checkAgainstServer,
  findConfig,
  loadConfig,
  openCaptureSession,
} from "@pixelslash/engine";
import { RemoteError } from "./api.ts";
import { readFlagPairs, takeJson } from "./args.ts";
import { type Remote, connect, resolveProject } from "./remote.ts";
import type { Io } from "./run.ts";
import { flakeRetries } from "./upload.ts";

export const CHECK_USAGE =
  "pixelslash check [--config FILE] [--out DIR] [--base BRANCH] [--only NAME]... [--server URL] [--token-path PATH] [--project ID|NAME] [--flake-retries N] [--json]\nCaptures the config's routes (the app must already be up), fetches the baselines the server would pick for this commit, and writes the same report `compare` does into DIR/report. Nothing is uploaded. Exit 0 whether or not anything changed; 3 when the server refuses or cannot be reached.";

const FLAGS = [
  "config",
  "out",
  "base",
  "server",
  "token-path",
  "project",
  "flake-retries",
] as const;

/** `--only NAME` may repeat, which a flag map cannot hold: pull the pairs out first. */
function takeOnly(argv: string[]): { only: string[] | undefined; rest: string[] } {
  const only: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a !== "--only") {
      rest.push(a);
      continue;
    }
    const name = argv[++i];
    if (!name || name.startsWith("--")) throw new UsageError("missing value for --only");
    only.push(name);
  }
  return { only: only.length > 0 ? only : undefined, rest };
}

function summary(result: CheckResult): string {
  const lines: string[] = [];
  const { changed, unchanged, added, removed, mismatched } = result;
  lines.push(
    `pixelslash: ${changed.length} changed, ${unchanged.length} unchanged, ${added.length} new, ${removed.length} removed`,
  );
  if (mismatched.length > 0)
    lines.push(
      `fingerprint: ${mismatched.length} shots rendered by a different environment than their baseline (diffed anyway)`,
    );
  for (const { entry, record } of result.flaky) {
    const { width, height } = entry.variant.viewport;
    lines.push(
      `flaky: ${entry.name} (${width}x${height} ${entry.variant.theme}): ${record.differed.length} of ${record.runs} runs differed`,
    );
  }
  lines.push("measured locally: a preview, nothing uploaded");
  lines.push(`report: ${pathToFileURL(result.indexPath).href}`);
  return `${lines.join("\n")}\n`;
}

/** `--json`, for agents: the counts, where things are, and every shot with its regions. */
function jsonOf(result: CheckResult): string {
  const { git } = result;
  return JSON.stringify(
    {
      measured: "local",
      uploaded: false,
      git: { commit: git.commitSha, branch: git.branch, mergeBase: git.mergeBaseSha },
      counts: {
        changed: result.changed.length,
        unchanged: result.unchanged.length,
        new: result.added.length,
        removed: result.removed.length,
        mismatched: result.mismatched.length,
        flaky: result.flaky.length,
      },
      report: result.indexPath,
      flakeReport: result.flakeReport ?? null,
      dirs: result.dirs,
      shots: result.shots,
    },
    null,
    2,
  );
}

/**
 * `pixelslash check`: capture, then measure against the server's baselines without uploading
 * anything (ob 1732). Exit 0 whatever changed; a refused or unreachable server is a RemoteError
 * (exit 3), as it is for every remote command that only reads.
 */
type Flags = Partial<Record<(typeof FLAGS)[number], string>>;

/** Where to look and as whom; a personal token reaches several projects, so it names one. */
async function optionsOf(flags: Flags, remote: Remote, cwd: string): Promise<CheckOptions> {
  const projectId = remote.token.startsWith("psu_")
    ? (await resolveProject(remote, flags.project)).id
    : undefined;
  return {
    out: resolve(cwd, flags.out ?? "pixelslash-check"),
    server: remote.client.server,
    token: remote.token,
    projectId,
    flakeRetries: 0,
    git: { cwd, baseBranch: flags.base ?? remote.upload?.baseBranch ?? "main" },
  };
}

export async function runCheck(
  argv: string[],
  io: Io,
  deps: SnapshotDeps & UploadDeps = {},
): Promise<number> {
  const { json, rest } = takeJson(argv);
  const { only, rest: pairs } = takeOnly(rest);
  const flags = readFlagPairs(pairs, FLAGS);
  const retries = flakeRetries(flags["flake-retries"]);
  const cwd = deps.cwd ?? process.cwd();
  const config = await loadConfig(findConfig(flags.config, cwd));
  const remote = await connect(flags, { ...deps, cwd });
  const warn = deps.warn ?? ((m: string) => io.stderr.write(`${m}\n`));
  const opts = await optionsOf(flags, remote, cwd);
  opts.only = only;
  opts.flakeRetries = retries ?? config.flake.retries;
  const session = await openCaptureSession(config, { ...deps, warn });
  try {
    const result = await checkAgainstServer(session, opts, { ...deps, warn });
    io.stdout.write(json ? `${jsonOf(result)}\n` : summary(result));
    return 0;
  } catch (e) {
    // The client's errors say `upload failed`; this command uploads nothing.
    if (e instanceof UploadError)
      throw new RemoteError(e.message.replace(/^upload failed/, "check failed"));
    throw e;
  } finally {
    await session.close();
  }
}
