import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI reads the merge-base and ancestors from git, and the server picks a baseline from them.
 * Run from the worktree, "main" and "review" uploads would both carry the worktree's HEAD and the
 * review build would find no baseline whenever HEAD is ahead of main. So the uploads come from a
 * small repo of their own: `main` at one commit, `work` one commit on top of it.
 */
let repo: string | undefined;

function git(cwd: string, ...args: string[]) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

/** The repo's path, with `branch` checked out. */
export function checkout(branch: "main" | "work"): string {
  if (!repo) {
    repo = mkdtempSync(join(tmpdir(), "ps-review-git-"));
    const id = ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com"];
    git(repo, "init", "-q", "-b", "main");
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "base");
    git(repo, "switch", "-q", "-c", "work");
    git(repo, ...id, "commit", "-q", "--allow-empty", "-m", "change");
  }
  git(repo, "switch", "-q", branch);
  return repo;
}

export function removeHistoryRepo() {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
}
