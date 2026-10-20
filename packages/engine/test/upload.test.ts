import { afterAll, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadError, UsageError } from "../src/errors.ts";
import { gitContext } from "../src/git.ts";
import { readManifest, uploadSnapshots } from "../src/upload.ts";
import { fakeServer, metaOf } from "./fake-server.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-up-"));
  dirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
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
async function repo(mainCommits: number, featCommits: number) {
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

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const FP = { image: "version:t", browser: "chromium 1", fonts: "sha256:f" };

function entry(name: string, variant = "desktop", extra: object = {}) {
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

async function snapshotDir(
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

const gitOpts = (cwd: string, extra: object = {}) => ({
  cwd,
  baseBranch: "main",
  branch: undefined,
  pr: undefined,
  env: {},
  warn: () => {},
  ...extra,
});

describe("gitContext", () => {
  test("commit, branch, merge-base with the base branch and nearest-first ancestors", async () => {
    const { dir, fork } = await repo(3, 2);
    const head = await git(dir, "rev-parse", "HEAD");
    const ctx = await gitContext(gitOpts(dir));
    expect(ctx).toMatchObject({
      commitSha: head,
      branch: "feat",
      mergeBaseSha: fork,
      prNumber: null,
    });
    expect(ctx.ancestorShas).toEqual((await git(dir, "rev-list", "HEAD")).split("\n").slice(1));
    expect(ctx.ancestorShas).toHaveLength(2);
  });

  test("ancestors stop at 20", async () => {
    const { dir } = await repo(1, 25);
    expect((await gitContext(gitOpts(dir))).ancestorShas).toHaveLength(20);
  });

  test("CI's env names the branch and the PR; flags win", async () => {
    const { dir } = await repo(1, 1);
    await git(dir, "checkout", "-q", "--detach");
    const env = { GITHUB_HEAD_REF: "feature/x", GITHUB_REF: "refs/pull/42/merge" };
    expect(await gitContext(gitOpts(dir, { env }))).toMatchObject({
      branch: "feature/x",
      prNumber: 42,
    });
    expect(await gitContext(gitOpts(dir, { env, branch: "b", pr: 7 }))).toMatchObject({
      branch: "b",
      prNumber: 7,
    });
    await expect(gitContext(gitOpts(dir))).rejects.toThrow(UsageError);
  });

  test("no base branch in the checkout is a null merge-base and a warning", async () => {
    const { dir } = await repo(1, 1);
    const warnings: string[] = [];
    const ctx = await gitContext(
      gitOpts(dir, { baseBranch: "nope", warn: (m: string) => warnings.push(m) }),
    );
    expect(ctx.mergeBaseSha).toBeNull();
    expect(warnings[0]).toMatch(/no merge-base with nope/);
  });

  test("outside a git repo is an UploadError", async () => {
    await expect(gitContext(gitOpts(await tmp()))).rejects.toThrow(UploadError);
  });
});

describe("readManifest", () => {
  test("reads a valid manifest", async () => {
    const mobile = entry("home", "mobile");
    mobile.variant.viewport.width = 390;
    const dir = await snapshotDir([entry("home"), mobile]);
    expect((await readManifest(dir)).snapshots.map((s) => s.file)).toEqual([
      "home/desktop.png",
      "home/mobile.png",
    ]);
  });

  test.each([
    ["a missing manifest", async () => tmp(), /no manifest\.json/],
    [
      "a wrong version",
      async () => snapshotDir([], { version: 2, snapshots: [] }),
      /version must be 1/,
    ],
    [
      "a file outside the dir",
      async () =>
        snapshotDir([], { version: 1, snapshots: [entry("x", "d", { file: "../x.png" })] }),
      /outside/,
    ],
    [
      "a missing PNG",
      async () => snapshotDir([], { version: 1, snapshots: [entry("x")] }),
      /does not exist/,
    ],
    [
      "two entries for one snapshot",
      async () => snapshotDir([entry("x")], { version: 1, snapshots: [entry("x"), entry("x")] }),
      /two entries/,
    ],
    [
      "a bad theme",
      async () =>
        snapshotDir([entry("x")], {
          version: 1,
          snapshots: [{ ...entry("x"), variant: { ...entry("x").variant, theme: "sepia" } }],
        }),
      /theme/,
    ],
  ])("refuses %s", async (_name, make, message) => {
    await expect(readManifest(await make())).rejects.toThrow(message);
  });

  test("refuses a file that is not a PNG", async () => {
    const dir = await snapshotDir([entry("x")]);
    await Bun.write(join(dir, "x/desktop.png"), "not a png at all");
    await expect(readManifest(dir)).rejects.toThrow(/not a PNG/);
  });
});

describe("uploadSnapshots", () => {
  test("opens a build, sends every PNG with its metadata, then finalises", async () => {
    const { dir: cwd, fork } = await repo(2, 1);
    const dir = await snapshotDir([entry("home"), entry("pricing", "dark", { tags: ["billing"] })]);
    const server = fakeServer();
    const result = await uploadSnapshots(
      { dir, server: "https://ps.example/", token: "psci_t", git: gitOpts(cwd) },
      { fetch: server.fetch },
    );

    expect(result).toMatchObject({ buildId: "b1", snapshots: 2 });
    expect(server.calls.every((c) => c.auth === "Bearer psci_t")).toBe(true);
    const [create, ...rest] = server.calls;
    expect(create).toMatchObject({ method: "POST", url: "https://ps.example/api/v1/builds" });
    expect(create?.body).toMatchObject({ branch: "feat", mergeBaseSha: fork, prNumber: null });
    const puts = rest.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url)).toEqual(
      Array(2).fill("https://ps.example/api/v1/builds/b1/snapshots"),
    );
    const metas = puts.map((c) => metaOf(c.body));
    expect(metas.map((m) => m.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "home",
      "pricing",
    ]);
    expect(metas.find((m) => m.name === "pricing")).toMatchObject({
      platform: "linux",
      viewport: "1280x720",
      theme: "light",
      tags: ["billing"],
      diff: { threshold: 0.2 },
      fingerprint: FP,
    });
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "https://ps.example/api/v1/builds/b1/finalize",
      body: { snapshots: 2 },
    });
  });

  test("a refused PNG throws and the build is never finalised", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("home"), entry("pricing")]);
    const server = fakeServer((c) =>
      c.method === "PUT" ? Response.json({ error: "boom" }, { status: 500 }) : undefined,
    );
    await expect(
      uploadSnapshots(
        { dir, server: "https://ps.example", token: "t", git: gitOpts(cwd) },
        { fetch: server.fetch },
      ),
    ).rejects.toThrow(/PUT \/api\/v1\/builds\/b1\/snapshots -> 500 boom/);
    expect(server.calls.some((c) => c.url.endsWith("/finalize"))).toBe(false);
  });

  test("a refused token stops at the first request", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("home")]);
    const server = fakeServer(() => Response.json({ error: "bad token" }, { status: 401 }));
    await expect(
      uploadSnapshots(
        { dir, server: "https://ps.example", token: "t", git: gitOpts(cwd) },
        { fetch: server.fetch },
      ),
    ).rejects.toThrow(/401 bad token/);
    expect(server.calls).toHaveLength(1);
  });

  test("an unreachable server is an UploadError", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("home")]);
    await expect(
      uploadSnapshots(
        { dir, server: "https://ps.example", token: "t", git: gitOpts(cwd) },
        {
          fetch: async () => {
            throw new Error("connection refused");
          },
        },
      ),
    ).rejects.toThrow(UploadError);
  });

  test("nothing is sent when the manifest is bad or the server is not a URL", async () => {
    const { dir: cwd } = await repo(1, 1);
    const server = fakeServer();
    const opts = (dir: string, serverUrl = "https://ps.example") => ({
      dir,
      server: serverUrl,
      token: "t",
      git: gitOpts(cwd),
    });
    await expect(uploadSnapshots(opts(await tmp()), { fetch: server.fetch })).rejects.toThrow(
      UsageError,
    );
    const dir = await snapshotDir([entry("home")]);
    await expect(uploadSnapshots(opts(dir, "ftp://x"), { fetch: server.fetch })).rejects.toThrow(
      UsageError,
    );
    expect(server.calls).toHaveLength(0);
  });
});
