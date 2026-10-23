import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { run } from "../src/run.ts";
import { capture, cleanup, servePaths, solidPng } from "./support.ts";
import { gitRepo } from "./upload-support.ts";

afterAll(cleanup);

/** `pixelslash check` (ob 1732): exit 0 whatever changed, 2 on a usage error, 3 when refused. */

const SERVER = "https://ps.example";
const pinned = { PIXELSLASH_IMAGE_VERSION: "test", PIXELSLASH_TOKEN: "psci_t" };

type Seen = { method: string; path: string };

/**
 * A server that picks a red baseline for every shot, or refuses everything with `refuse`. With
 * `reportsRemoved: false` its reply has no `removed`, as one from before ob 1732 has none.
 */
function server(refuse?: number, reportsRemoved = true) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push({ method: init?.method ?? "GET", path });
    if (refuse) return Response.json({ error: "no" }, { status: refuse });
    if (path === "/api/v1/baselines") {
      const keys: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}").keys;
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      const baseline = {
        id: "s0",
        image_url: "/images/s0.png",
        fingerprint: { image: "version:test", browser: "chromium 1", fonts: "sha256:f" },
        ignore: [],
      };
      return Response.json({
        api_version: 1,
        diff_location: "server",
        baselines: keys.map((key) => ({ key, baseline, carry: null, accepted: null })),
        ...(reportsRemoved ? { removed: [] } : {}),
      });
    }
    if (path.startsWith("/images/")) return new Response(solidPng(400, 300, [200, 0, 0, 255]));
    return Response.json({ error: "not here" }, { status: 404 });
  };
  return { fetch, seen };
}

async function project() {
  const cwd = await gitRepo();
  await Bun.write(
    join(cwd, "pixelslash.config.json"),
    JSON.stringify({
      baseUrl: servePaths({ "/": "live.html" }),
      routes: ["/"],
      variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
    }),
  );
  return cwd;
}

describe("pixelslash check", () => {
  test("--json says what changed against the server's pick, and sends only reads", async () => {
    const [cwd, api, cap] = [await project(), server(), capture()];
    const code = await run(
      ["check", "--server", SERVER, "--flake-retries", "0", "--json"],
      cap.io,
      { fetch: api.fetch, cwd, env: pinned, listFonts: async () => [] },
    );
    expect(code).toBe(0);
    const out: unknown = JSON.parse(cap.stdout);
    expect(out).toMatchObject({
      measured: "local",
      uploaded: false,
      counts: { changed: 1, unchanged: 0, new: 0, removed: 0, mismatched: 1, flaky: 0 },
      shots: [{ name: "index", status: "changed", mismatch: ["browser", "fonts"] }],
    });
    expect(api.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/v1/baselines",
      "GET /images/s0.png",
    ]);
    expect(await Bun.file(join(cwd, "pixelslash-check", "report", "index.html")).exists()).toBe(
      true,
    );
  }, 60_000);

  test("the summary names the changed shot under the counts line", async () => {
    const [cwd, api, cap] = [await project(), server(), capture()];
    const code = await run(["check", "--server", SERVER, "--flake-retries", "0"], cap.io, {
      fetch: api.fetch,
      cwd,
      env: pinned,
      listFonts: async () => [],
    });
    expect(code).toBe(0);
    const lines = cap.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("pixelslash: "));
    expect(lines[at]).toBe("pixelslash: 1 changed, 0 unchanged, 0 new, 0 removed");
    expect(lines.slice(at + 1, at + 3)).toEqual(["changed:", "  index (chromium 400x300)"]);
  }, 60_000);

  test("a server that does not report removed shots is said so, and --json has a null count", async () => {
    const [cwd, api] = [await project(), server(undefined, false)];
    const deps = { fetch: api.fetch, cwd, env: pinned, listFonts: async () => [] };
    const text = capture();
    expect(await run(["check", "--server", SERVER, "--flake-retries", "0"], text.io, deps)).toBe(0);
    expect(text.stdout).toContain(
      "pixelslash: 1 changed, 0 unchanged, 0 new, removed not reported by this server\n",
    );
    expect(text.stdout).not.toContain("0 removed");
    const json = capture();
    await run(["check", "--server", SERVER, "--flake-retries", "0", "--json"], json.io, deps);
    expect(JSON.parse(json.stdout)).toMatchObject({ counts: { changed: 1, removed: null } });
  }, 60_000);

  test("a refused token is exit 3, after nothing was written to the server", async () => {
    const [cwd, api, cap] = [await project(), server(401), capture()];
    const code = await run(["check", "--server", SERVER], cap.io, {
      fetch: api.fetch,
      cwd,
      env: pinned,
      listFonts: async () => [],
    });
    expect(code).toBe(3);
    expect(cap.stderr).toMatch(/^check failed: fetch baselines/m);
    expect(cap.stderr).not.toMatch(/upload failed/);
    expect(api.seen.every((s) => s.method === "POST" && s.path === "/api/v1/baselines")).toBe(true);
  }, 60_000);

  test("a bad flag, --only with no name, or an unknown route is a usage error, exit 2", async () => {
    const cwd = await project();
    const deps = { fetch: server().fetch, cwd, env: pinned, listFonts: async () => [] };
    const bad = capture();
    expect(await run(["check", "--live", "x"], bad.io, deps)).toBe(2);
    expect(bad.stderr).toContain("pixelslash check [--config FILE]");
    expect(await run(["check", "--only"], capture().io, deps)).toBe(2);
    const unknown = capture();
    expect(await run(["check", "--server", SERVER, "--only", "nope"], unknown.io, deps)).toBe(2);
    expect(unknown.stderr).toMatch(/--only: no route nope/);
  }, 60_000);
});
