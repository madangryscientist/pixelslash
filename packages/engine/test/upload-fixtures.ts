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

/** Feeds one `git fast-import` stream: one spawn for any number of commits. */
async function fastImport(cwd: string, stream: string) {
  const proc = Bun.spawn(["git", "fast-import", "--quiet"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.stdin.write(stream);
  await proc.stdin.end();
  if ((await proc.exited) !== 0)
    throw new Error(`git fast-import: ${await new Response(proc.stderr).text()}`);
}

/**
 * Appends `n` empty commits to the checked-out branch in one `git fast-import` stream. One spawn
 * instead of `n`: a `git commit` per row is what made the 200-ancestor test hit Vitest's timeout.
 */
export async function emptyCommits(cwd: string, n: number, prefix: string) {
  const ref = await git(cwd, "symbolic-ref", "HEAD");
  const tip = await git(cwd, "rev-parse", "HEAD");
  const head = `commit ${ref}\ncommitter t <t@example.com> 0 +0000\n`;
  let stream = "";
  for (let i = 0; i < n; i++) {
    const msg = `${prefix}${i}`;
    stream += `${head}data ${msg.length}\n${msg}\n${i ? "" : `from ${tip}\n`}`;
  }
  await fastImport(cwd, stream);
}

/**
 * main has `mainCommits` commits; branch `feat` forks from the first and adds `featCommits`.
 * Both branches are one `git fast-import` stream, four processes whatever the counts: a `git
 * commit` per commit cost one each, and a starved runner spent a test's whole budget starting them.
 * Committer dates step along each branch, so the order a `rev-list` gives back is fixed.
 */
export async function repo(mainCommits: number, featCommits: number) {
  const dir = await tmp();
  await git(dir, "init", "-q", "-b", "main");
  let stream = "";
  let mark = 0;
  let date = 0;
  /** Writes one commit and returns its mark, so the next one on that ref can name it as `from`. */
  const commit = (ref: string, message: string, from: number | null) => {
    const id = ++mark;
    stream += `commit ${ref}\nmark :${id}\ncommitter t <t@example.com> ${1_700_000_000 + date++} +0000\n`;
    stream += `data ${message.length}\n${message}\n`;
    if (from !== null) stream += `from :${from}\n`;
    return id;
  };
  const mains = Math.max(1, mainCommits);
  let forkMark = 0;
  let parent: number | null = null;
  for (let i = 0; i < mains; i++) {
    parent = commit("refs/heads/main", `m${i}`, parent);
    if (i === 0) forkMark = parent;
  }
  if (featCommits > 0) {
    parent = forkMark;
    for (let i = 0; i < featCommits; i++) parent = commit("refs/heads/feat", `f${i}`, parent);
  } else {
    // No commit to carry `feat`, so name the branch at the fork; HEAD still ends up on it.
    stream += `reset refs/heads/feat\nfrom :${forkMark}\n`;
  }
  await fastImport(dir, stream);
  const fork = await git(dir, "rev-parse", `main~${mains - 1}`);
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
