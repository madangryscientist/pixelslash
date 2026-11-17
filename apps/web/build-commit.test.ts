import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildCommit } from "./build-commit.ts";

describe("buildCommit", () => {
  let repo = "";
  let bare = "";
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "build-commit-repo-"));
    bare = mkdtempSync(join(tmpdir(), "build-commit-none-"));
    // Git looks no higher than the temp dirs' parent, so neither finds an enclosing checkout.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", dirname(repo));
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "first");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  test("BUILD_COMMIT wins over git", () => {
    expect(buildCommit({ env: { BUILD_COMMIT: "abc123" }, cwd: repo })).toBe("abc123");
  });

  test("an empty BUILD_COMMIT reads as unset", () => {
    expect(buildCommit({ env: { BUILD_COMMIT: "" }, cwd: repo })).toBe(git("rev-parse", "HEAD"));
  });

  test("a clean checkout is its HEAD; a changed one adds -dirty", () => {
    const head = git("rev-parse", "HEAD");
    expect(buildCommit({ env: {}, cwd: repo })).toBe(head);
    writeFileSync(join(repo, "b.txt"), "untracked\n");
    expect(buildCommit({ env: {}, cwd: repo })).toBe(`${head}-dirty`);
    rmSync(join(repo, "b.txt"));
  });

  test("no git and no BUILD_COMMIT is unknown", () => {
    expect(buildCommit({ env: {}, cwd: bare })).toBe("unknown");
  });
});
