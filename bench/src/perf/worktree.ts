/** The scratch space of a perf run and the temporary git worktree of its base (ob 1790). */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Under the user's cache dir, not /tmp (a small tmpfs here) and not the repo: a base checkout with
 * its `node_modules` is hundreds of MB.
 */
export const CACHE_ROOT = join(
  process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
  "pixelslash-perf",
);

export type Run = { code: number; out: string; err: string };

/** Every child the runner is waiting on (git, install, build, probe); a signal ends them all. */
export const running = new Set<ReturnType<typeof Bun.spawn>>();

export async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  running.add(proc);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: out.trim(), err: err.trim() };
  } finally {
    running.delete(proc);
  }
}

/** The commit a ref names, or null when there is no such ref. */
export async function resolveRef(root: string, ref: string): Promise<string | null> {
  const r = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  return r.code === 0 ? r.out : null;
}

/** `--base` when given (an unknown ref is an error), else `origin/main`, else `main`, else null. */
export async function pickBase(root: string, given: string | null): Promise<string | null> {
  if (given !== null) {
    const sha = await resolveRef(root, given);
    if (sha === null) throw new Error(`--base ${given}: no such ref`);
    return sha;
  }
  return (await resolveRef(root, "origin/main")) ?? (await resolveRef(root, "main"));
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Remove a base worktree: git's record and the directory both. */
export async function removeWorktree(root: string, path: string): Promise<void> {
  await run(["git", "worktree", "remove", "--force", path], root);
  rmSync(path, { recursive: true, force: true });
  await run(["git", "worktree", "prune"], root);
}

/** A run killed without a chance to clean up (SIGKILL) leaves `base-<pid>`; the next run removes it. */
export async function sweepStale(root: string): Promise<void> {
  if (!existsSync(CACHE_ROOT)) return;
  for (const entry of readdirSync(CACHE_ROOT)) {
    const pid = Number(/^(?:base|run)-(\d+)$/.exec(entry)?.[1]);
    if (!Number.isInteger(pid) || alive(pid)) continue;
    await removeWorktree(root, join(CACHE_ROOT, entry));
  }
}

/**
 * Check `sha` out detached at `path`, put this tree's perf folder over it (the base may not have
 * it, or an older one) and install. The folder is the measuring tool; the engine and the web app
 * it measures stay the base's own.
 */
export async function addBaseWorktree(root: string, sha: string, path: string): Promise<void> {
  mkdirSync(CACHE_ROOT, { recursive: true });
  const added = await run(["git", "worktree", "add", "--detach", path, sha], root);
  if (added.code !== 0) throw new Error(`git worktree add failed: ${added.err}`);
  cpSync(join(root, "bench/src/perf"), join(path, "bench/src/perf"), { recursive: true });
  const installed = await run(["bun", "install", "--frozen-lockfile"], path);
  if (installed.code !== 0)
    throw new Error(`bun install failed in the base worktree: ${installed.err.slice(-1500)}`);
}
