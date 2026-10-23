import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { UploadError, UsageError } from "../src/errors.ts";
import { gitContext } from "../src/git.ts";
import { readManifest } from "../src/manifest.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { CLIENT_VERSION } from "../src/version.ts";
import { fakeServer, metaOf } from "./fake-server.ts";
import {
  FP,
  cleanup,
  emptyCommits,
  entry,
  git,
  gitOpts,
  repo,
  snapshotDir,
  tmp,
} from "./upload-fixtures.ts";

afterAll(cleanup);

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
    // The merge-base's own history, not the branch's: main's, nearest first.
    expect(ctx.ancestorShas).toEqual(
      (await git(dir, "rev-list", "--first-parent", fork)).split("\n").slice(1),
    );
    expect(ctx.ancestorShas).toHaveLength(0);
  });

  test("the ancestors are the merge-base's first-parent history, up to 200", async () => {
    const { dir, fork } = await repo(1, 3);
    await git(dir, "checkout", "-q", "main");
    await emptyCommits(dir, 205, "n");
    const tip = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "feat");
    await git(dir, "merge", "-q", "--no-edit", "main");
    const ctx = await gitContext(gitOpts(dir));
    expect(ctx.mergeBaseSha).toBe(tip);
    expect(ctx.ancestorShas).toHaveLength(200);
    expect(ctx.ancestorShas[0]).toBe(await git(dir, "rev-parse", `${tip}~1`));
    expect(ctx.ancestorShas).not.toContain(fork);
  });

  test("with no merge-base, HEAD's own 20 nearest parents", async () => {
    const { dir } = await repo(1, 25);
    const ctx = await gitContext(gitOpts(dir, { baseBranch: "nope" }));
    expect(ctx.ancestorShas).toHaveLength(20);
    expect(ctx.ancestorShas[0]).toBe(await git(dir, "rev-parse", "HEAD~1"));
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
    expect(server.calls.every((c) => c.userAgent === `pixelslash/${CLIENT_VERSION}`)).toBe(true);
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

  test("sends each snapshot's ignore rects, [] when it has none", async () => {
    const { dir: cwd } = await repo(1, 1);
    const box = { x: 4, y: 8, width: 100, height: 50 };
    const dir = await snapshotDir([entry("home", "desktop", { ignore: [box] }), entry("pricing")]);
    const server = fakeServer();
    await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      { fetch: server.fetch },
    );
    const metas = server.calls.filter((c) => c.method === "PUT").map((c) => metaOf(c.body));
    expect(metas.find((m) => m.name === "home")?.ignore).toEqual([box]);
    expect(metas.find((m) => m.name === "pricing")?.ignore).toEqual([]);
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
