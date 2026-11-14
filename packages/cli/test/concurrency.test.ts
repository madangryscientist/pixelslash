import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { run } from "../src/run.ts";
import { PAGES, capture, cleanup, exitReport, servePaths, solidPng, tmp } from "./support.ts";
import { changedBaselines, fakeUploadApi, gitRepo } from "./upload-support.ts";

afterAll(cleanup);
afterAll(() => vi.unstubAllEnvs());

/** `--concurrency N`: how many shots run at once, over the config's own `concurrency`. */

const SERVER = "https://ps.example";
const ENV = { PIXELSLASH_IMAGE_VERSION: "t", PIXELSLASH_TOKEN: "psci_t" };
const ROUTES = ["/a", "/b", "/c", "/d"];

/** One page per path in `ROUTES`, all the same file, so a run has four shots. */
const four = () => servePaths(Object.fromEntries(ROUTES.map((r) => [r, "live.html"])));

async function configFor(origin: string, extra: Record<string, unknown>, routes = ROUTES) {
  const config = join(await tmp(), "pixelslash.config.json");
  await Bun.write(
    config,
    JSON.stringify({
      baseUrl: origin,
      routes,
      variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
      ...extra,
    }),
  );
  return config;
}

/** A page that answers slowly and records how many requests for it were open at once. */
function slowPage() {
  const state = { open: 0, most: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/") return new Response("not found", { status: 404 });
      state.open++;
      state.most = Math.max(state.most, state.open);
      await Bun.sleep(500);
      state.open--;
      return new Response(Bun.file(join(PAGES, "live.html")), {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const stop = () => void server.stop(true);
  return { origin: `http://127.0.0.1:${server.port}`, state, stop };
}

function workers(stdout: string): unknown {
  const out: { timings?: { workers?: { capture?: number } } } = JSON.parse(stdout);
  return out.timings?.workers?.capture;
}

describe("capture --concurrency", () => {
  test("takes that many shots at once over the config's, without --upload, and says nothing", async () => {
    const config = await configFor(four(), { concurrency: 3 });
    const base = ["capture", "--config", config, "--json"];
    const [over, kept] = [capture(), capture()];
    const env = { PIXELSLASH_IMAGE_VERSION: "t" };
    const code = await run(
      [...base, "--out", join(await tmp(), "a"), "--concurrency", "2"],
      over.io,
      { env },
    );
    expect(exitReport(code, over.stderr)).toBe("exit 0");
    expect(workers(over.stdout)).toBe(2);
    expect(over.stderr).not.toMatch(/concurrency:/);
    // The same run without the flag still takes the config's 3.
    expect(await run([...base, "--out", join(await tmp(), "b")], kept.io, { env })).toBe(0);
    expect(workers(kept.stdout)).toBe(3);
  }, 120_000);
});

describe("check --concurrency", () => {
  test("takes that many shots at once over the config's", async () => {
    const cwd = await gitRepo();
    const config = await configFor(four(), { concurrency: 3 });
    const baselines = changedBaselines();
    const cap = capture();
    const fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.startsWith("/images/")) return new Response(solidPng(400, 300, [200, 0, 0, 255]));
      return baselines.fetch(url, init);
    };
    const code = await run(
      [
        "check",
        "--config",
        config,
        "--server",
        SERVER,
        "--flake-retries",
        "0",
        "--concurrency",
        "2",
        "--json",
      ],
      cap.io,
      { fetch, cwd, env: ENV },
    );
    expect(exitReport(code, cap.stderr)).toBe("exit 0");
    expect(workers(cap.stdout)).toBe(2);
    expect(cap.stderr).not.toMatch(/concurrency:/);
  }, 120_000);
});

/** A shot that differs from its baseline is captured `--flake-retries` more times, up to `--concurrency` at once. */
describe("re-captures of changed shots", () => {
  test("upload DIR re-captures N at a time over the config's concurrency", async () => {
    // `upload DIR` opens its own session, which reads the pinned image from the process env.
    vi.stubEnv("PIXELSLASH_IMAGE_VERSION", "t");
    const page = slowPage();
    try {
      const cwd = await gitRepo();
      const config = await configFor(page.origin, { concurrency: 3 }, ["/"]);
      const dir = join(await tmp(), "snaps");
      const taken = capture();
      expect(
        await run(["capture", "--config", config, "--out", dir], taken.io, { env: ENV, cwd }),
      ).toBe(0);
      page.state.most = 0;
      const [api, cap] = [changedBaselines(), capture()];
      const code = await run(
        [
          "upload",
          dir,
          "--config",
          config,
          "--server",
          SERVER,
          "--flake-retries",
          "4",
          "--concurrency",
          "2",
        ],
        cap.io,
        { fetch: api.fetch, cwd, env: ENV },
      );
      expect(exitReport(code, cap.stderr)).toBe("exit 0");
      expect(page.state.most).toBe(2);
    } finally {
      page.stop();
    }
  }, 120_000);

  test("capture --upload captures with N and re-captures N at a time", async () => {
    const page = slowPage();
    try {
      const cwd = await gitRepo();
      const config = await configFor(page.origin, { concurrency: 3 }, ["/"]);
      const [api, cap] = [changedBaselines(), capture()];
      const out = join(await tmp(), "out");
      const code = await run(
        [
          "capture",
          "--config",
          config,
          "--out",
          out,
          "--upload",
          "--server",
          SERVER,
          "--flake-retries",
          "4",
          "--concurrency",
          "2",
        ],
        cap.io,
        { fetch: api.fetch, cwd, env: ENV },
      );
      expect(exitReport(code, cap.stderr)).toBe("exit 0");
      expect(page.state.most).toBe(2);
    } finally {
      page.stop();
    }
  }, 120_000);
});

describe("--concurrency that is not 1 to 32", () => {
  const bad = ["0", "33", "2.5", "x"];
  const commands: Record<string, string[]> = {
    capture: ["capture"],
    "capture --upload": ["capture", "--upload", "--server", SERVER],
    check: ["check", "--server", SERVER],
    upload: ["upload", "dir", "--server", SERVER],
  };

  for (const [name, argv] of Object.entries(commands)) {
    test(`${name} exits 2 naming the flag`, async () => {
      for (const value of bad) {
        const [api, cap] = [fakeUploadApi(), capture()];
        const code = await run([...argv, "--concurrency", value], cap.io, {
          fetch: api.fetch,
          env: ENV,
        });
        expect(code).toBe(2);
        expect(cap.stderr).toMatch(/--concurrency must be a whole number/);
        expect(api.calls).toHaveLength(0);
      }
      // A flag with no value at all.
      const cap = capture();
      expect(await run([...argv, "--concurrency"], cap.io, { env: ENV })).toBe(2);
      expect(cap.stderr).toMatch(/missing value for --concurrency/);
    });
  }

  test("the message names the bounds", async () => {
    const cap = capture();
    await run(["capture", "--concurrency", "33"], cap.io, {});
    expect(cap.stderr).toMatch(/--concurrency must be a whole number from 1 to 32 \(got "33"\)/);
  });
});
