import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the upload tests: temp git repos and snapshot dirs, removed by `cleanup`. */
const dirs: string[] = [];
export const cleanup = () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));

export async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-up-"));
  dirs.push(dir);
  return dir;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

/** main has `mainCommits` commits; branch `feat` forks from the first and adds `featCommits`. */
export async function repo(mainCommits: number, featCommits: number) {
  const dir = await tmp();
  await git(dir, "init", "-q", "-b", "main");
  const commit = (n: string) => git(dir, "commit", "-q", "--allow-empty", "-m", n);
  await commit("m0");
  const fork = await git(dir, "rev-parse", "HEAD");
  await git(dir, "checkout", "-q", "-b", "feat");
  for (let i = 0; i < featCommits; i++) await commit(`f${i}`);
  await git(dir, "checkout", "-q", "main");
  for (let i = 1; i < mainCommits; i++) await commit(`m${i}`);
  await git(dir, "checkout", "-q", "feat");
  return { dir, fork };
}

export const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
export const FP = { image: "version:t", browser: "chromium 1", fonts: "sha256:f" };

export function entry(name: string, variant = "desktop", extra: object = {}) {
  return {
    name,
    path: `/${name}`,
    variant: {
      name: variant,
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      theme: "light",
    },
    tags: ["web"],
    diff: { threshold: 0.2 },
    file: `${name}/${variant}.png`,
    fingerprint: FP,
    ...extra,
  };
}

export async function snapshotDir(
  entries: { file: string }[],
  manifest: object = { version: 1, snapshots: entries },
) {
  const dir = await tmp();
  for (const e of entries) {
    await mkdir(join(dir, e.file, ".."), { recursive: true });
    await Bun.write(join(dir, e.file), PNG_HEAD);
  }
  await Bun.write(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

export const gitOpts = (cwd: string, extra: object = {}) => ({
  cwd,
  baseBranch: "main",
  branch: undefined,
  pr: undefined,
  env: {},
  warn: () => {},
  ...extra,
});
