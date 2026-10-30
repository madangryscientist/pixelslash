import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CheckOptions,
  type CheckResult,
  type SnapshotDeps,
  type UploadDeps,
  UploadError,
  changeLines,
  checkAgainstServer,
  findConfig,
  loadConfig,
  onlyRoutes,
  openCaptureSession,
  timingLine,
} from "@pixelslash/engine";
import { RemoteError } from "./api.ts";
import { readFlagPairs, takeJson, takeOnly } from "./args.ts";
import { type Remote, connect, namesProject, resolveProject } from "./remote.ts";
import type { Io } from "./run.ts";
import { flakeRetries } from "./upload.ts";
import { type Watch, watched } from "./watch.ts";

export const CHECK_USAGE =
  "pixelslash check [--config FILE] [--out DIR] [--base BRANCH] [--only NAME]... [--server URL] [--token-path PATH] [--project ID|NAME] [--flake-retries N] [--json]\nCaptures the config's routes (the app must already be up), fetches the baselines the server would pick for this commit, and writes the same report `compare` does into DIR/report. Nothing is uploaded. Exit 0 whether or not anything changed; 3 when the server refuses or cannot be reached.";

const CHECK_FLAGS = [
  "config",
  "out",
  "base",
  "server",
  "token-path",
  "project",
  "flake-retries",
] as const;

function summary(result: CheckResult): string {
  const lines: string[] = [];
  const { changed, unchanged, added, removed, mismatched } = result;
  // A server before ob 1732 does not say what it would remove: say so rather than "0 removed".
  const gone = result.removedReported
    ? `${removed.length} removed`
    : "removed not reported by this server";
  lines.push(
    `pixelslash: ${changed.length} changed, ${unchanged.length} unchanged, ${added.length} new, ${gone}`,
  );
  lines.push(...changeLines(result));
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

/** `--json` and `check_local`: the counts, where things are, and every shot with its regions. */
export function checkJson(result: CheckResult) {
  const { git } = result;
  return {
    measured: "local",
    uploaded: false,
    git: { commit: git.commitSha, branch: git.branch, mergeBase: git.mergeBaseSha },
    counts: {
      changed: result.changed.length,
      unchanged: result.unchanged.length,
      new: result.added.length,
      removed: result.removedReported ? result.removed.length : null,
      mismatched: result.mismatched.length,
      flaky: result.flaky.length,
    },
    report: result.indexPath,
    flakeReport: result.flakeReport ?? null,
    dirs: result.dirs,
    timings: result.timings,
    shots: result.shots,
  };
}

/**
 * `pixelslash check`: capture, then measure against the server's baselines without uploading
 * anything (ob 1732). Exit 0 whatever changed; a refused or unreachable server is a RemoteError
 * (exit 3), as it is for every remote command that only reads.
 */
export type CheckFlags = Partial<Record<(typeof CHECK_FLAGS)[number], string>>;

/** Where to look and as whom; a personal or org token reaches several projects, so it names one. */
async function optionsOf(flags: CheckFlags, remote: Remote, cwd: string): Promise<CheckOptions> {
  const projectId = namesProject(remote.token)
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

/** Capture and measure against the server's baselines; `pixelslash check` and `check_local`. */
export async function checkLocal(
  flags: CheckFlags,
  only: string[] | undefined,
  deps: SnapshotDeps & UploadDeps,
  watch: Watch = {},
): Promise<CheckResult> {
  const started = performance.now();
  const retries = flakeRetries(flags["flake-retries"]);
  const cwd = deps.cwd ?? process.cwd();
  const config = await loadConfig(findConfig(flags.config, cwd));
  const remote = await connect(flags, { ...deps, cwd });
  const opts = await optionsOf(flags, remote, cwd);
  opts.only = only;
  opts.flakeRetries = retries ?? config.flake.retries;
  const session = await openCaptureSession(config, deps);
  try {
    const total = onlyRoutes(session, only).routes.length * config.variants.length;
    // The total counts from the command's start, the browser launch included.
    return await checkAgainstServer(watched(session, watch, total), opts, { ...deps, started });
  } catch (e) {
    if (e instanceof UploadError) throw new RemoteError(e.message);
    throw e;
  } finally {
    await session.close();
  }
}

export async function runCheck(
  argv: string[],
  io: Io,
  deps: SnapshotDeps & UploadDeps = {},
): Promise<number> {
  const { json, rest } = takeJson(argv);
  const { only, rest: pairs } = takeOnly(rest);
  const flags = readFlagPairs(pairs, CHECK_FLAGS);
  const warn = deps.warn ?? ((m: string) => io.stderr.write(`${m}\n`));
  const result = await checkLocal(flags, only, { ...deps, warn });
  io.stdout.write(json ? `${JSON.stringify(checkJson(result), null, 2)}\n` : summary(result));
  io.stderr.write(`${timingLine(result.timings)}\n`);
  return 0;
}
