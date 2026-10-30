import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { provision } from "./api-upload";
import { png } from "./png";
import { SERVER } from "./ports";

/**
 * A project nx/turbo "affected" skipped for 55 commits of main (ob 1788): the real CLI reads the
 * ancestors from a real repo, and the branch is compared against the early main build, not `new`.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");
const SKIPPED = 55;

const temps: string[] = [];
test.afterAll(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ps-deep-"));
  temps.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]) {
  const id = ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com"];
  await run("git", [...id, ...args], { cwd });
}

async function snapshotDir(image: Buffer) {
  const dir = await tempDir();
  await mkdir(join(dir, "home"));
  await writeFile(join(dir, "home/desktop.png"), image);
  const entry = {
    name: "home",
    path: "/",
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 40, height: 40 },
      theme: "light",
    },
    tags: ["web"],
    file: "home/desktop.png",
    fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}

/** The real CLI, run from the repo so it reads the commit, merge-base and ancestors there. */
function upload(repo: string, dir: string, token: string, branch: string) {
  const res = spawnSync("bun", [CLI, "upload", dir, "--server", SERVER, "--branch", branch], {
    cwd: repo,
    env: { ...process.env, PIXELSLASH_TOKEN: token },
    encoding: "utf8",
  });
  expect(res.status, res.stderr).toBe(0);
  return /build: (\S+)/.exec(res.stdout)?.[1] ?? "";
}

async function shotOf(buildId: string): Promise<Record<string, string> | undefined> {
  const { stdout } = await run(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--json",
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      ".wrangler/e2e",
      "--command",
      `SELECT diff_status, image_key, baseline_key FROM snapshots WHERE build_id = '${buildId}'`,
    ],
    { cwd: WEB },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("[")))[0].results[0];
}

test("a branch finds the main build CI skipped for 55 commits", async ({ page }) => {
  const { token } = await provision(page, "Deep Co", "skipped");
  const repo = await tempDir();
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "early");
  const early = upload(repo, await snapshotDir(png(40, 40)), token, "main");
  for (let i = 0; i < SKIPPED; i++)
    await git(repo, "commit", "-q", "--allow-empty", "-m", `unaffected ${i}`);
  await git(repo, "switch", "-q", "-c", "feat");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "change");

  const changed = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);
  const branch = upload(repo, await snapshotDir(changed), token, "feat");
  expect(await shotOf(branch)).toMatchObject({
    diff_status: "changed",
    baseline_key: (await shotOf(early))?.image_key,
  });
});
