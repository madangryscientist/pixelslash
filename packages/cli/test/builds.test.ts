import { afterAll, describe, expect, test } from "vitest";
import { CLIENT_VERSION, type ProcLike } from "@pixelslash/engine";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { SERVER, USER_TOKEN, fakeApi } from "./remote-support.ts";
import { gitRepo, snapshotDir } from "./upload-support.ts";

afterAll(cleanup);

const deps = async (api = fakeApi()) => ({
  env: { PIXELSLASH_TOKEN: USER_TOKEN },
  fetch: api.fetch,
  cwd: await tmp(),
});

const proc = (code: number): ProcLike => ({
  stdout: new Response("downloading\n").body,
  stderr: null,
  exited: Promise.resolve(code),
  exitCode: code,
  signalCode: null,
});

describe("pixelslash builds / build", () => {
  test("builds prints a table and passes --branch and --limit through", async () => {
    const api = fakeApi();
    const cap = capture();
    const argv = ["builds", "--server", SERVER, "--branch", "feature", "--limit", "5"];
    expect(await run(argv, cap.io, await deps(api))).toBe(0);
    const query = api.seen.at(-1)?.url.searchParams;
    expect([query?.get("branch"), query?.get("limit")]).toEqual(["feature", "5"]);
    expect(cap.stdout.split("\n")[0]).toMatch(
      /^ID\s+BRANCH\s+COMMIT\s+STATUS\s+TO REVIEW\s+CREATED$/,
    );
    expect(cap.stdout).toMatch(
      /^b2\s+feature\s+4f2c1ab\s+changes\s+1\s+2026-10-22T09:00:00.000Z$/m,
    );
  });

  test("--json prints the API's reply unchanged", async () => {
    const api = fakeApi();
    const cap = capture();
    expect(await run(["builds", "--server", SERVER, "--json"], cap.io, await deps(api))).toBe(0);
    expect(cap.stdout).toBe(`${JSON.stringify(api.replies["/api/v1/projects/p1/builds"])}\n`);
  });

  test("a bad --limit is a usage error", async () => {
    const code = await run(
      ["builds", "--server", SERVER, "--limit", "0"],
      capture().io,
      await deps(),
    );
    expect(code).toBe(2);
  });

  test("build latest reads the newest build, then that build", async () => {
    const api = fakeApi();
    const cap = capture();
    expect(
      await run(["build", "latest", "--server", SERVER, "--json"], cap.io, await deps(api)),
    ).toBe(0);
    expect(api.seen.map((s) => `${s.url.pathname}${s.url.search}`)).toEqual([
      "/api/v1/projects",
      "/api/v1/projects/p1/builds?limit=1",
      "/api/v1/builds/b2",
    ]);
    expect(cap.stdout).toBe(`${JSON.stringify(api.replies["/api/v1/builds/b2"])}\n`);
  });

  test("build ID prints the build and its snapshots", async () => {
    const cap = capture();
    expect(await run(["build", "b2", "--server", SERVER], cap.io, await deps())).toBe(0);
    expect(cap.stdout).toContain("build b2  changes");
    expect(cap.stdout).toContain("feature @ 4f2c1ab  PR #42");
    expect(cap.stdout).toMatch(/^home\s+1280x720\s+light\s+changed\s+pending$/m);
  });

  test("an id the token cannot reach exits 3", async () => {
    const cap = capture();
    expect(await run(["build", "nope", "--server", SERVER], cap.io, await deps())).toBe(3);
    expect(cap.stderr).toContain("404 not_found");
  });
});

describe("upload with a personal token", () => {
  test("names the resolved project when it opens the build", async () => {
    const [cwd, dir, api] = [await gitRepo(), await snapshotDir(), fakeApi()];
    const code = await run(["upload", dir, "--server", SERVER], capture().io, {
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch: api.fetch,
      cwd,
    });
    expect(code).toBe(0);
    const open = api.seen.find((s) => s.method === "POST" && s.url.pathname === "/api/v1/builds");
    expect(JSON.parse(open?.body ?? "{}")).toMatchObject({ projectId: "p1", branch: "feat" });
  });

  test("a refused project lookup is a refused upload: exit 1, not 3", async () => {
    const [cwd, dir] = [await gitRepo(), await snapshotDir()];
    const code = await run(["upload", dir, "--server", SERVER], capture().io, {
      env: { PIXELSLASH_TOKEN: "psu_revoked" },
      fetch: fakeApi().fetch,
      cwd,
    });
    expect(code).toBe(1);
  });
});

describe("--version and install-browser", () => {
  test("--version prints the version the User-Agent sends", async () => {
    const cap = capture();
    expect(await run(["--version"], cap.io)).toBe(0);
    expect(cap.stdout).toBe(`pixelslash ${CLIENT_VERSION}\n`);
  });

  test("install-browser runs Playwright's installer for chromium-headless-shell", async () => {
    const calls: string[][] = [];
    const ok = capture();
    const spawn = (code: number) => (cmd: string[]) => {
      calls.push(cmd);
      return proc(code);
    };
    expect(await run(["install-browser"], ok.io, { spawn: spawn(0) })).toBe(0);
    expect(ok.stdout).toBe("downloading\n");
    expect(calls[0]?.slice(-2)).toEqual(["install", "chromium-headless-shell"]);
    expect(calls[0]?.[1]).toMatch(/playwright[/\\]cli\.js$/);
    const failed = capture();
    expect(await run(["install-browser"], failed.io, { spawn: spawn(1) })).toBe(3);
    expect(failed.stderr).toContain("installing chromium-headless-shell failed");
  });
});
