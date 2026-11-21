import { type UploadDeps, uploadSkipped } from "@slashsuite/pixelslash-engine";
import { prNumber, readFlagPairs } from "./args.ts";
import { uploadProgress } from "./failure.ts";
import type { Io } from "./run.ts";
import { UPLOAD_FLAGS, type UploadFlags, failedUpload, resolveTarget } from "./upload.ts";

/**
 * `pixelslash upload --skipped`: this commit captured nothing on purpose (a task cache skipped the
 * capture), so the server records a passed build with no shots and the commit still gets its
 * PixelSlash status. No DIR, no shot, no baseline change.
 */
export async function uploadSkippedRun(rest: string[], io: Io, deps: UploadDeps): Promise<number> {
  const flags: UploadFlags = readFlagPairs(rest, UPLOAD_FLAGS);
  const cwd = deps.cwd ?? process.cwd();
  try {
    const target = await resolveTarget(flags, deps, cwd);
    const { buildId, recorded, git } = await uploadSkipped(
      {
        server: target.server,
        token: target.token,
        projectId: target.projectId,
        subproject: target.subproject,
        git: { cwd, baseBranch: target.baseBranch, branch: flags.branch, pr: prNumber(flags.pr) },
      },
      { ...deps, warn: (m) => io.stderr.write(`${m}\n`) },
    );
    io.stdout.write(
      recorded
        ? "pixelslash: recorded a skipped run (no shots)\n"
        : "pixelslash: this commit already has a build; nothing recorded\n",
    );
    io.stdout.write(`build: ${buildId} (${git.commitSha.slice(0, 7)} on ${git.branch})\n`);
    return 0;
  } catch (e) {
    throw failedUpload(e, uploadProgress());
  }
}
