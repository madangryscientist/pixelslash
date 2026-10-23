import { UploadError, UsageError } from "./errors.ts";

/** What the server needs to know about where a build sits in history. */
export type GitContext = {
  commitSha: string;
  branch: string;
  /** Null when the base branch is not in the checkout (a shallow clone). */
  mergeBaseSha: string | null;
  /**
   * The merge-base's first-parent ancestors, nearest first, at most `MAX_ANCESTORS`; HEAD's own
   * (20) when there is no merge-base.
   */
  ancestorShas: string[];
  prNumber: number | null;
};

/**
 * The server accepts at most this many; the baseline pick takes the nearest. Deep enough for a
 * project that nx/turbo "affected" skipped for a long stretch of main (ob 1788).
 */
export const MAX_ANCESTORS = 200;

/** With no merge-base there is no history to walk but HEAD's own, and it stays as it was. */
const HEAD_ANCESTORS = 20;

export type GitOptions = {
  cwd: string;
  baseBranch: string;
  branch: string | undefined;
  pr: number | undefined;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
  /** The command asking, for its messages. Default `upload`. */
  command?: "upload" | "check";
};

/** stdout of `git <args>` trimmed, or undefined when git exits non-zero. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.trim() : undefined;
}

function prFromRef(ref: string | undefined): number | null {
  const m = /^refs\/pull\/(\d+)\//.exec(ref ?? "");
  return m?.[1] ? Number(m[1]) : null;
}

/** `--branch`, else CI's env (a PR build is checked out detached), else HEAD's branch name. */
async function branchName(opts: GitOptions): Promise<string> {
  const { cwd, env } = opts;
  const branch =
    opts.branch ||
    env.GITHUB_HEAD_REF ||
    env.GITHUB_REF_NAME ||
    (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]));
  if (!branch) throw new UsageError("HEAD is detached: pass --branch NAME");
  return branch;
}

/** The merge-base with the base branch, preferring the remote's copy; null when neither is here. */
async function mergeBase(opts: GitOptions): Promise<string | null> {
  const { cwd, baseBranch } = opts;
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    if (!(await git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]))) continue;
    const base = await git(cwd, ["merge-base", "HEAD", ref]);
    if (base) return base;
  }
  const doing = opts.command === "check" ? "checking" : "uploading";
  opts.warn(
    `warning: no merge-base with ${baseBranch} (not in this checkout, or a shallow clone); ${doing} without one`,
  );
  return null;
}

/** Read the commit, branch, merge-base with the base branch and ancestor list from the local checkout. */
export async function gitContext(opts: GitOptions): Promise<GitContext> {
  const commitSha = await git(opts.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!commitSha)
    throw new UploadError(
      `${opts.command ?? "upload"} needs a git checkout with a commit: ${opts.cwd}`,
    );
  const mergeBaseSha = await mergeBase(opts);
  // A baseline is a build of the base branch at or before the merge-base, so that is where the
  // list starts: first-parent follows main's own history (a squash or merge commit, not the
  // branch merged into it). Without one, HEAD's parents are all there is to offer.
  const log = await git(
    opts.cwd,
    mergeBaseSha
      ? ["rev-list", "--first-parent", `--max-count=${MAX_ANCESTORS + 1}`, mergeBaseSha]
      : ["rev-list", `--max-count=${HEAD_ANCESTORS + 1}`, "HEAD"],
  );
  return {
    commitSha,
    branch: await branchName(opts),
    mergeBaseSha,
    ancestorShas: (log ?? "").split("\n").filter(Boolean).slice(1),
    prNumber: opts.pr ?? prFromRef(opts.env.GITHUB_REF),
  };
}
