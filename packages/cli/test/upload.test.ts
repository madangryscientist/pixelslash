import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, servePaths, tmp } from "./support.ts";
import { fakeUploadApi, gitRepo, snapshotDir } from "./upload-support.ts";

afterAll(cleanup);

const SERVER = "https://ps.example";

describe("pixelslash upload", () => {
  test("uploads the dir with the token from PIXELSLASH_TOKEN and prints the build", async () => {
    const [cwd, dir, api, cap] = [await gitRepo(), await snapshotDir(), fakeUploadApi(), capture()];
    const code = await run(["upload", dir, "--server", SERVER], cap.io, {
      fetch: api.fetch,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_env" },
    });
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/uploaded 1 snapshots\nbuild: build-1 \([0-9a-f]{7} on feat\)/);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/builds",
      "PUT /api/v1/builds/build-1/snapshots",
      "POST /api/v1/builds/build-1/finalize",
    ]);
    expect(api.calls.every((c) => c.auth === "Bearer psci_env")).toBe(true);
    // The timing line goes to stderr, with the upload's time; stdout is as it was.
    expect(cap.stderr).toMatch(/^timing: 1 shot, upload \d+\.\ds, total \d+\.\ds\n$/);
  });

  test("the token can come from --token-path, the server from env or the config", async () => {
    const [cwd, dir, api] = [await gitRepo(), await snapshotDir(), fakeUploadApi()];
    const tokenPath = join(await tmp(), "token");
    await Bun.write(tokenPath, "psci_file\n");
    await Bun.write(
      join(cwd, "pixelslash.config.json"),
      JSON.stringify({
        baseUrl: "http://x",
        routes: ["/"],
        upload: { server: SERVER, baseBranch: "main" },
      }),
    );
    const code = await run(["upload", dir, "--token-path", tokenPath], capture().io, {
      fetch: api.fetch,
      cwd,
      env: {},
    });
    expect(code).toBe(0);
    expect(api.calls[0]?.auth).toBe("Bearer psci_file");
  });

  test("a refused upload exits 1 and says why", async () => {
    const [cwd, dir, api, cap] = [
      await gitRepo(),
      await snapshotDir(),
      fakeUploadApi(401),
      capture(),
    ];
    const code = await run(["upload", dir, "--server", SERVER], cap.io, {
      fetch: api.fetch,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_revoked" },
    });
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/POST \/api\/v1\/builds -> 401 no/);
  });

  test("no token, no server, no dir or a bad flag are usage errors, exit 2, nothing sent", async () => {
    const [cwd, dir, api] = [await gitRepo(), await snapshotDir(), fakeUploadApi()];
    const HOME = await tmp();
    const deps = (env: NodeJS.ProcessEnv) => ({ fetch: api.fetch, cwd, env: { HOME, ...env } });
    const tries: [string[], NodeJS.ProcessEnv, RegExp][] = [
      [
        ["upload", dir, "--server", SERVER],
        {},
        /not logged in to https:\/\/ps.example: run `pixelslash login/,
      ],
      [["upload", dir], { PIXELSLASH_TOKEN: "t" }, /need --server URL/],
      [["upload"], {}, /need a snapshot DIR/],
      [["upload", dir, "--bogus", "x"], {}, /unexpected argument: --bogus/],
      [
        ["upload", dir, "--server", SERVER, "--pr", "zero"],
        { PIXELSLASH_TOKEN: "t" },
        /--pr must be/,
      ],
      [
        ["upload", dir, "--server", SERVER, "--flake-retries", "-1"],
        { PIXELSLASH_TOKEN: "t" },
        /--flake-retries must be a non-negative integer/,
      ],
    ];
    for (const [argv, env, message] of tries) {
      const cap = capture();
      expect(await run(argv, cap.io, deps(env))).toBe(2);
      expect(cap.stderr).toMatch(message);
    }
    expect(api.calls).toHaveLength(0);
  });

  test("--brief FILE and --brief-text send the author's words, trimmed, with the build", async () => {
    const [cwd, dir] = [await gitRepo(), await snapshotDir()];
    await Bun.write(join(cwd, "brief.md"), "  Make the header sticky.\n");
    const env = { PIXELSLASH_TOKEN: "psci_env" };
    const sent = async (flags: string[]) => {
      const api = fakeUploadApi();
      expect(
        await run(["upload", dir, "--server", SERVER, ...flags], capture().io, {
          fetch: api.fetch,
          cwd,
          env,
        }),
      ).toBe(0);
      const body: unknown = JSON.parse(api.calls[0]?.body ?? "{}");
      return body;
    };
    expect(await sent(["--brief", "brief.md"])).toHaveProperty("brief", "Make the header sticky.");
    expect(await sent(["--brief-text", "One line."])).toHaveProperty("brief", "One line.");
    expect(await sent([])).not.toHaveProperty("brief");
  });

  test("both brief flags, a missing file or an over-long brief are exit 2, nothing sent", async () => {
    const [cwd, dir, api] = [await gitRepo(), await snapshotDir(), fakeUploadApi()];
    await Bun.write(join(cwd, "long.md"), "x".repeat(4001));
    const tries: [string[], RegExp][] = [
      [["--brief", "a.md", "--brief-text", "b"], /--brief FILE or --brief-text TEXT, not both/],
      [["--brief", "missing.md"], /--brief: no such file: missing.md/],
      [["--brief", "long.md"], /brief is 4001 characters; the limit is 4000/],
    ];
    for (const [flags, message] of tries) {
      const cap = capture();
      const code = await run(["upload", dir, "--server", SERVER, ...flags], cap.io, {
        fetch: api.fetch,
        cwd,
        env: { PIXELSLASH_TOKEN: "t" },
      });
      expect(code).toBe(2);
      expect(cap.stderr).toMatch(message);
    }
    expect(api.calls).toHaveLength(0);
  });

  test("--judge with no local judge says `skip: no judge` and uploads as without it", async () => {
    const [cwd, dir, api, cap] = [await gitRepo(), await snapshotDir(), fakeUploadApi(), capture()];
    const code = await run(["upload", dir, "--server", SERVER, "--judge"], cap.io, {
      fetch: api.fetch,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_env" },
      which: () => null,
    });
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/^skip: no judge\n[\s\S]*uploaded 1 snapshots/);
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
  });
});

async function captureConfig() {
  const origin = servePaths({ "/": "live.html" });
  const config = join(await tmp(), "c.json");
  await Bun.write(config, JSON.stringify({ baseUrl: origin, routes: ["/"] }));
  return config;
}

describe("capture --upload", () => {
  const pinned = {
    env: { PIXELSLASH_IMAGE_VERSION: "test", PIXELSLASH_TOKEN: "psci_t" },
    listFonts: async () => [],
  };

  test("uploads what it just captured", async () => {
    const [config, cwd, api, cap] = [
      await captureConfig(),
      await gitRepo(),
      fakeUploadApi(),
      capture(),
    ];
    const out = join(await tmp(), "out");
    const code = await run(
      ["capture", "--config", config, "--out", out, "--upload", "--server", SERVER],
      cap.io,
      { ...pinned, fetch: api.fetch, cwd },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/pixelslash: 1 snapshots[\s\S]*uploaded 1 snapshots/);
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
  }, 60_000);

  test("without --upload nothing is sent, and upload-only flags are refused", async () => {
    const [config, cwd, api, cap] = [
      await captureConfig(),
      await gitRepo(),
      fakeUploadApi(),
      capture(),
    ];
    const out = join(await tmp(), "out");
    const deps = { ...pinned, fetch: api.fetch, cwd };
    expect(await run(["capture", "--config", config, "--out", out], cap.io, deps)).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(await run(["capture", "--config", config, "--server", SERVER], cap.io, deps)).toBe(2);
    expect(cap.stderr).toMatch(/need --upload/);
    expect(await run(["capture", "--config", config, "--flake-retries", "0"], cap.io, deps)).toBe(
      2,
    );
    expect(await run(["capture", "--config", config, "--judge"], cap.io, deps)).toBe(2);
    expect(api.calls).toHaveLength(0);
  }, 60_000);
});
