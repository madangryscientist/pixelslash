import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { DS, capture, cleanup, exitReport, newMissSpawn, servePaths, tmp } from "./support.ts";
import { run } from "../src/run.ts";
import { REJECTED_EXIT, WAITING_EXIT } from "../src/status.ts";
import { UNSTABLE_EXIT } from "../src/flake.ts";
import { INTERNAL_EXIT } from "../src/failure.ts";
import { DRIFT_EXIT } from "../src/parity-pairs.ts";
import { REMOTE_EXIT } from "../src/api.ts";
import { SERVER, USER_TOKEN, build, fakeApi } from "./remote-support.ts";
import { android, deps as parityDeps, parityApi, web } from "./parity-support.ts";

afterAll(cleanup);

const CHILD = fileURLToPath(new URL("./exit-child.ts", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Run `cmd` with both streams as pipes, read to the end, and return what the parent saw. */
async function piped(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("exitAfterFlush", () => {
  test("a child that writes over 1 MB to a pipe and exits through the helper is read whole", async () => {
    for (let i = 0; i < 3; i++) {
      const out = await piped([process.execPath, CHILD]);
      expect(out.code).toBe(3);
      expect(out.stdout.length).toBeGreaterThan(1_000_000);
      expect(JSON.parse(out.stdout).rows).toHaveLength(20000);
      expect(out.stderr.trim()).toHaveLength(300_000);
    }
  });

  test("the real entry point pipes `status --json` whole", async () => {
    const api = fakeApi();
    const snapshots = Array.from({ length: 6000 }, (_, i) => ({
      name: `shot-${i}`,
      viewport: "1280x720",
      theme: "light",
      group: "changed",
      review_state: "pending",
      skipped_flaky: false,
    }));
    api.replies["/api/v1/builds/b2"] = { api_version: 1, build: { ...build("b2"), snapshots } };
    const server = Bun.serve({
      port: 0,
      fetch: (req) => api.fetch(req.url, { method: req.method, headers: req.headers }),
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      for (let i = 0; i < 3; i++) {
        const out = await piped(
          [process.execPath, ENTRY, "status", "--build", "b2", "--json", "--server", url],
          { PIXELSLASH_TOKEN: USER_TOKEN },
        );
        expect(out.stdout.length).toBeGreaterThan(500_000);
        expect(JSON.parse(out.stdout).build.snapshots).toHaveLength(6000);
        expect(out.code).toBe(WAITING_EXIT);
      }
    } finally {
      await server.stop(true);
    }
  }, 30_000);
});

const CLI_DOC = fileURLToPath(new URL("../../../docs/cli.md", import.meta.url));
const UPLOAD_TEST = fileURLToPath(new URL("./upload.test.ts", import.meta.url));

/** Run `argv` in process and return the code with what it wrote. */
async function runs(argv: string[], d: Parameters<typeof run>[2] = {}) {
  const cap = capture();
  const code = await run(argv, cap.io, d);
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

/** The fake API's build `b2` with its status replaced. */
const b2 = (api: ReturnType<typeof fakeApi>, status: string) => {
  api.replies["/api/v1/builds/b2"] = { api_version: 1, build: { ...build("b2"), status } };
};
const remote = async (api: Pick<ReturnType<typeof fakeApi>, "fetch">) => ({
  env: { PIXELSLASH_TOKEN: USER_TOKEN },
  fetch: api.fetch,
  cwd: await tmp(),
});

/** A stub of the flake endpoints, enough for `flake f1` to capture the shot it names. */
async function flakeFetch(raw: string) {
  const path = new URL(raw).pathname;
  if (path === "/api/v1/me") return Response.json({ kind: "user", user: { id: "u1", login: "a" } });
  if (path === "/api/v1/projects")
    return Response.json({
      projects: [{ id: "p1", name: "web", org: { id: "o1", name: "Acme" } }],
      next_cursor: null,
    });
  if (path === "/api/v1/projects/p1/flakes")
    return Response.json({
      flakes: [
        {
          id: "f1",
          name: "random",
          platform: "web",
          browser: "chromium",
          viewport: "400x300",
          theme: "light",
          status: "open",
          note: null,
          evidence: [{ build_id: "b1" }, { build_id: "b2" }],
          updated_at: "2026-10-22T09:00:00.000Z",
        },
      ],
      next_cursor: null,
    });
  return Response.json({ error: "not here" }, { status: 404 });
}

/**
 * One entry per way a documented exit code is reached. `path` says which real path `prove`
 * drives (`prove` returns the exit code, in process). The doc test below checks the code set
 * here against the table in docs/cli.md, so a code added to either side fails until both move.
 */
const PROVED: Array<{ code: number; path: string; prove: () => Promise<number> }> = [
  {
    code: 0,
    path: "the same shot on Main and Branch: no change, no violation",
    prove: async () => {
      const png = join(DS, "button.png");
      return (await runs(["--live-png", png, "--local-png", png, "--out", join(await tmp(), "o")]))
        .code;
    },
  },
  {
    code: 1,
    path: "a new design-system violation on Branch",
    prove: async () => {
      const out = join(await tmp(), "o");
      const argv = ["--live-png", join(DS, "button.png"), "--local-png", join(DS, "card.png")];
      return (await runs([...argv, "--ds", DS, "--out", out], { spawn: newMissSpawn() })).code;
    },
  },
  {
    code: 1,
    path: "a failed capture: a page that is down (the run failed, not a verdict on the page)",
    prove: async () => {
      const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
      const url = `http://127.0.0.1:${gone.port}/`;
      await gone.stop(true);
      const r = await runs(["--live", url, "--local", url, "--out", join(await tmp(), "o")]);
      expect(r.stderr).toContain(`capture failed for ${url}`);
      return r.code;
    },
  },
  {
    code: 2,
    path: "a usage error: status with two ways to pick the build",
    prove: async () =>
      (
        await runs(
          ["status", "--server", SERVER, "--build", "b2", "--branch", "x"],
          await remote(fakeApi()),
        )
      ).code,
  },
  {
    code: REMOTE_EXIT,
    path: "the server does not know the build id (404)",
    prove: async () =>
      (await runs(["build", "nope", "--server", SERVER], await remote(fakeApi()))).code,
  },
  {
    code: REJECTED_EXIT,
    path: "status on a build a reviewer rejected",
    prove: async () => {
      const api = fakeApi();
      b2(api, "failed");
      return (await runs(["status", "--server", SERVER, "--build", "b2"], await remote(api))).code;
    },
  },
  {
    code: WAITING_EXIT,
    path: "status on a build that still waits for review",
    prove: async () =>
      (await runs(["status", "--server", SERVER, "--build", "b2"], await remote(fakeApi()))).code,
  },
  {
    code: UNSTABLE_EXIT,
    path: "flake on a page whose element moves between runs",
    prove: async () => {
      const cwd = await tmp();
      await Bun.write(
        join(cwd, "pixelslash.config.json"),
        JSON.stringify({
          baseUrl: servePaths({ "/": "live.html", "/random": "random.html" }),
          routes: ["/", { path: "/random", name: "random" }],
          variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
        }),
      );
      const d = { fetch: flakeFetch, cwd, env: { PIXELSLASH_TOKEN: "psu_t" } };
      return (await runs(["flake", "f1", "--server", SERVER, "--runs", "3"], d)).code;
    },
  },
  {
    code: INTERNAL_EXIT,
    path: "a crash: a shot the diff cannot decode",
    prove: async () => {
      const dir = await tmp();
      await Bun.write(join(dir, "bad.png"), "not a png");
      const r = await runs([
        "--live-png",
        join(dir, "bad.png"),
        "--local-png",
        join(DS, "button.png"),
        "--out",
        join(dir, "o"),
      ]);
      expect(r.stderr).toContain("pixelslash: FAILED compare:");
      return r.code;
    },
  },
  {
    code: DRIFT_EXIT,
    path: "parity on a twin pair whose button gap differs (8 vs 6)",
    prove: async () => {
      const api = parityApi([web({ gap: 8 }), android({ gap: 6 })]);
      return (await runs(["parity", "--build", "b2", "--server", SERVER], await parityDeps(api)))
        .code;
    },
  },
  {
    code: 130,
    path: "upload stopped by SIGINT: upload.test.ts, `SIGINT exits 130` (a real child process)",
    prove: async () => {
      const text = await Bun.file(UPLOAD_TEST).text();
      expect(text).toContain('test("SIGINT exits 130"');
      expect(text).toContain("expect(code).toBe(130)");
      return 130;
    },
  },
  {
    code: 143,
    path: "upload stopped by SIGTERM: upload.test.ts, `SIGTERM names the unfinished build and exits 143` (a real child process)",
    prove: async () => {
      const text = await Bun.file(UPLOAD_TEST).text();
      expect(text).toContain('test("SIGTERM names the unfinished build and exits 143"');
      expect(text).toContain("expect(code).toBe(143)");
      return 143;
    },
  },
];

describe("every documented exit code", () => {
  test.each(PROVED)(
    "exit $code: $path",
    async ({ code, prove }) => {
      const got = await prove();
      expect(exitReport(got, `wanted ${code}`)).toBe(exitReport(code, `wanted ${code}`));
    },
    90_000,
  );

  test("docs/cli.md lists exactly the codes this file proves", async () => {
    const doc = await Bun.file(CLI_DOC).text();
    const table = doc.split("**Exit codes.**")[1]?.split("### Exit codes and the `FAILED` line")[0];
    const prose = doc
      .split("### Exit codes and the `FAILED` line")[1]
      ?.split("### Error reporting")[0];
    expect(table, "the Exit codes table").toBeDefined();
    expect(prose, "the section under 'Exit codes and the FAILED line'").toBeDefined();
    const tabled = [...(table ?? "").matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
    // The signal exits are named in the prose, in bold: **143**, **130**.
    const signals = [...(prose ?? "").matchAll(/\*\*(\d{3})\*\*/g)].map((m) => Number(m[1]));
    const documented = [...new Set([...tabled, ...signals])].toSorted((a, b) => a - b);
    const proved = [...new Set(PROVED.map((p) => p.code))].toSorted((a, b) => a - b);
    expect(documented).toEqual(proved);
    expect(tabled).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
