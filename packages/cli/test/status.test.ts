import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { SERVER, USER_TOKEN, build, fakeApi } from "./remote-support.ts";
import { gitRepo, snapshotDir } from "./upload-support.ts";

afterAll(cleanup);

type Step = "processing" | "changes" | "passed" | "failed" | "errored";

const COUNTS: Record<Step, Record<string, number>> = {
  processing: { to_review: 0, accepted: 0, rejected: 0 },
  changes: { to_review: 1, accepted: 0, rejected: 0 },
  passed: { to_review: 0, accepted: 1, rejected: 0 },
  failed: { to_review: 0, accepted: 0, rejected: 1 },
  errored: { to_review: 0, accepted: 0, rejected: 0 },
};

const shot = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  viewport: "1280x720",
  theme: "light",
  group: "changed",
  review_state: "pending",
  skipped_flaky: false,
  ...extra,
});

/** The build read for `id`, as the server would answer it at `step`. */
const buildAt = (id: string, step: Step, snapshots = [shot("home")]) => ({
  api_version: 1,
  build: {
    ...build(id),
    status: step,
    error: step === "errored" ? "diff ceiling" : null,
    counts: { ...build(id).counts, ...COUNTS[step] },
    snapshots,
  },
});

/**
 * `fakeApi`, with `/api/v1/builds/<id>` walking `steps` one read at a time and staying on the
 * last. A fake clock: `sleep` moves `now` on, so a timeout costs no real time.
 */
function walk(steps: Step[], id = "b2", snapshots?: ReturnType<typeof shot>[]) {
  const api = fakeApi();
  let reads = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const fetch = (raw: string, init?: RequestInit) => {
    if (new URL(raw).pathname === `/api/v1/builds/${id}` && (init?.method ?? "GET") === "GET") {
      const step = steps[Math.min(reads, steps.length - 1)] ?? "processing";
      api.replies[`/api/v1/builds/${id}`] = buildAt(id, step, snapshots);
      reads += 1;
    }
    return api.fetch(raw, init);
  };
  return {
    api,
    sleeps,
    reads: () => reads,
    deps: async (cwd?: string) => ({
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch,
      cwd: cwd ?? (await tmp()),
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    }),
  };
}

const status = (...more: string[]) => ["status", "--server", SERVER, ...more];

const headOf = (cwd: string) =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd }).stdout.toString().trim();

describe("pixelslash status --wait", () => {
  test("processing → pending → accepted exits 0", async () => {
    const w = walk(["processing", "changes", "passed"]);
    const cap = capture();
    const code = await run(status("--build", "b2", "--wait"), cap.io, await w.deps());
    expect(code).toBe(0);
    expect(w.reads()).toBe(3);
    expect(w.sleeps).toEqual([15_000, 15_000]);
    expect(cap.stdout).toContain(`build b2  ${SERVER}/projects/p1/builds/b2`);
    expect(cap.stdout).toContain("passed: 0 waiting · 1 accepted · 0 rejected");
    expect(cap.stderr).toContain("waiting on build b2: processing");
    expect(cap.stderr).toContain("waiting on build b2: changes: 1 waiting");
  });

  test("processing → pending → rejected exits 4", async () => {
    const w = walk(["processing", "changes", "failed"]);
    const cap = capture();
    expect(await run(status("--build", "b2", "--wait"), cap.io, await w.deps())).toBe(4);
    expect(cap.stdout).toContain("failed: 0 waiting · 0 accepted · 1 rejected");
  });

  test("still pending at --timeout exits 5", async () => {
    const w = walk(["processing", "changes"]);
    const cap = capture();
    const argv = status("--build", "b2", "--wait", "--timeout", "1m", "--interval", "25s");
    expect(await run(argv, cap.io, await w.deps())).toBe(5);
    // 25 + 25 + the 10 s left, then one last read at the deadline.
    expect(w.sleeps).toEqual([25_000, 25_000, 10_000]);
    expect(w.reads()).toBe(4);
    expect(cap.stderr).toContain("still waiting after 60s");
  });

  test("an errored build exits 3 with its error", async () => {
    const w = walk(["processing", "errored"]);
    const cap = capture();
    expect(await run(status("--build", "b2", "--wait"), cap.io, await w.deps())).toBe(3);
    expect(cap.stdout).toContain("errored (diff ceiling)");
  });

  test("a flaky shot skipped by policy does not wait, and is listed on its own line", async () => {
    const shots = [shot("home"), shot("clock", { skipped_flaky: true })];
    const w = walk(["passed"], "b2", shots);
    const cap = capture();
    expect(await run(status("--build", "b2", "--wait"), cap.io, await w.deps())).toBe(0);
    expect(cap.stdout).toMatch(/^skipped flaky: clock \(1280x720 light\)$/m);
    expect(cap.stdout).not.toContain("skipped flaky: home");
  });
});

describe("pixelslash status without --wait", () => {
  test("reads once: pending exits 5, --json prints the reply as sent", async () => {
    const w = walk(["changes"]);
    const cap = capture();
    expect(await run(status("--build", "b2", "--json"), cap.io, await w.deps())).toBe(5);
    expect(w.reads()).toBe(1);
    expect(cap.stdout).toBe(`${JSON.stringify(buildAt("b2", "changes"))}\n`);
  });

  test("--branch picks the branch's newest build", async () => {
    const w = walk(["passed"]);
    const cap = capture();
    expect(await run(status("--branch", "feature"), cap.io, await w.deps())).toBe(0);
    const paths = w.api.seen.map((s) => `${s.url.pathname}${s.url.search}`);
    expect(paths).toContain("/api/v1/projects/p1/builds?branch=feature&limit=100");
    expect(paths.at(-1)).toBe("/api/v1/builds/b2");
  });

  test("--commit matches a build by its SHA's prefix", async () => {
    const w = walk(["passed"], "b1");
    w.api.replies["/api/v1/projects/p1/builds"] = {
      api_version: 1,
      builds: [build("b2"), { ...build("b1"), commit_sha: "abc1234ffff" }],
      next_cursor: null,
    };
    const cap = capture();
    expect(await run(status("--commit", "abc1234"), cap.io, await w.deps())).toBe(0);
    expect(cap.stdout).toContain("build b1");
  });

  test("by default reads the build `upload` recorded in the snapshot dir at this commit", async () => {
    const cwd = await gitRepo();
    const record = { server: SERVER, build: "b9", commit: headOf(cwd) };
    await Bun.write(join(cwd, "pixelslash-snapshots", "build.json"), JSON.stringify(record));
    const w = walk(["passed"], "b9");
    expect(await run(status(), capture().io, await w.deps(cwd))).toBe(0);
    expect(w.reads()).toBe(1);
  });

  test("a build recorded at another commit is stale: the current commit's build is read", async () => {
    const cwd = await gitRepo();
    const record = { server: SERVER, build: "b9", commit: "0000000" };
    await Bun.write(join(cwd, "pixelslash-snapshots", "build.json"), JSON.stringify(record));
    const w = walk(["passed"], "b1");
    w.api.replies["/api/v1/projects/p1/builds"] = {
      api_version: 1,
      builds: [{ ...build("b1"), commit_sha: headOf(cwd) }],
      next_cursor: null,
    };
    const cap = capture();
    expect(await run(status(), cap.io, await w.deps(cwd))).toBe(0);
    expect(cap.stdout).toContain("build b1");
  });

  test("with nothing recorded, the current commit's newest build", async () => {
    const cwd = await gitRepo();
    const head = headOf(cwd);
    const w = walk(["passed"], "b1");
    w.api.replies["/api/v1/projects/p1/builds"] = {
      api_version: 1,
      builds: [build("b2"), { ...build("b1"), commit_sha: head }],
      next_cursor: null,
    };
    const cap = capture();
    expect(await run(status(), cap.io, await w.deps(cwd))).toBe(0);
    expect(cap.stdout).toContain("build b1");
  });

  test("no build at the commit exits 3", async () => {
    const w = walk(["passed"]);
    const cap = capture();
    expect(await run(status("--commit", "deadbee"), cap.io, await w.deps())).toBe(3);
    expect(cap.stderr).toContain("no build in web at commit deadbee");
  });

  test.each([
    [["--build", "b2", "--branch", "x"]],
    [["--build", "b2", "--timeout", "1m"]],
    [["--build", "b2", "--wait", "--interval", "soon"]],
    [["--build", "b2", "--wait", "--timeout", "0s"]],
  ])("%j is a usage error", async (more) => {
    const w = walk(["passed"]);
    expect(await run(status(...more), capture().io, await w.deps())).toBe(2);
  });
});

describe("pixelslash upload --wait", () => {
  test("records the build in DIR, then waits for it and exits by its outcome", async () => {
    const [cwd, dir] = [await gitRepo(), await snapshotDir()];
    const w = walk(["changes", "failed"], "build-9");
    const cap = capture();
    const code = await run(
      ["upload", dir, "--server", SERVER, "--wait", "--interval", "5s"],
      cap.io,
      await w.deps(cwd),
    );
    expect(code).toBe(4);
    expect(cap.stdout).toContain("build: build-9");
    expect(cap.stdout).toContain("failed: 0 waiting · 0 accepted · 1 rejected");
    expect(await Bun.file(join(dir, "build.json")).json()).toEqual({
      server: SERVER,
      build: "build-9",
      commit: headOf(cwd),
    });
  });

  test("without --wait it exits 0 and does not read the build", async () => {
    const [cwd, dir] = [await gitRepo(), await snapshotDir()];
    const w = walk(["changes"], "build-9");
    expect(await run(["upload", dir, "--server", SERVER], capture().io, await w.deps(cwd))).toBe(0);
    expect(w.reads()).toBe(0);
  });
});
