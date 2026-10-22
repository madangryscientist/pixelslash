import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { UNSTABLE_EXIT } from "../src/flake.ts";
import { run } from "../src/run.ts";
import { capture, cleanup, servePaths, tmp } from "./support.ts";

afterAll(cleanup);

/** `pixelslash flakes` and `pixelslash flake ID` (ob 1725), against a stubbed server. */

const SERVER = "https://ps.example";
const env = { PIXELSLASH_TOKEN: "psu_t" };

const flake = (id: string, name: string, status = "open") => ({
  id,
  name,
  platform: "web",
  browser: "chromium",
  viewport: "400x300",
  theme: "light",
  status,
  note: null,
  evidence: [{ build_id: "b1" }, { build_id: "b2" }],
  updated_at: "2026-10-22T09:00:00.000Z",
});

type Seen = { method: string; path: string; body: string };

function server() {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ method: init?.method ?? "GET", path, body });
    if (path === "/api/v1/me")
      return Response.json({ kind: "user", user: { id: "u1", login: "ada" } });
    if (path === "/api/v1/projects")
      return Response.json({
        projects: [{ id: "p1", name: "web", org: { id: "o1", name: "Acme" } }],
        next_cursor: null,
      });
    if (path === "/api/v1/projects/p1/flakes")
      return Response.json({
        flakes: [flake("f1", "random"), flake("f2", "index"), flake("f3", "old", "resolved")],
        next_cursor: null,
      });
    if (path.startsWith("/api/v1/flakes/") && path.endsWith("/resolve"))
      return Response.json({ flake: { ...flake("f2", "index"), status: "resolved" } });
    return Response.json({ error: "not here" }, { status: 404 });
  };
  return { fetch, seen };
}

async function project(stabilise?: Record<string, unknown>) {
  const cwd = await tmp();
  await Bun.write(
    join(cwd, "pixelslash.config.json"),
    JSON.stringify({
      baseUrl: servePaths({ "/": "live.html", "/random": "random.html" }),
      routes: ["/", { path: "/random", name: "random" }],
      variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
      ...(stabilise && { stabilise }),
    }),
  );
  return cwd;
}

const flakeArgs = (id: string, ...more: string[]) => ["flake", id, "--server", SERVER, ...more];

describe("pixelslash flakes", () => {
  test("lists the open flakes", async () => {
    const [cwd, api] = [await tmp(), server()];
    const open = capture();
    expect(await run(["flakes", "--server", SERVER], open.io, { fetch: api.fetch, cwd, env })).toBe(
      0,
    );
    expect(open.stdout).toContain("f1  random (chromium 400x300 light)  2 builds");
    expect(open.stdout).not.toContain("f3");
    expect(api.seen.every((s) => s.method === "GET")).toBe(true);
  });
});

describe("pixelslash flake", () => {
  test("a random-position element: 5 runs, unstable, with the region and a report; --resolve does not resolve", async () => {
    const [cwd, api, cap] = [await project(), server(), capture()];
    const code = await run(flakeArgs("f1", "--resolve"), cap.io, { fetch: api.fetch, cwd, env });
    expect(code).toBe(UNSTABLE_EXIT);
    expect(cap.stdout).toContain("capturing it 5 times");
    expect(cap.stdout).toMatch(/unstable: [1-4] of 4 runs differed from run 1/);
    expect(cap.stdout).toMatch(/real change: \d+x\d+ at \d+,\d+/);
    expect(cap.stdout).toContain('Last resort: set `flaky: "skip"` on random');
    const out = join(cwd, "pixelslash-flake");
    expect(await Bun.file(join(out, "runs", "run5.png")).exists()).toBe(true);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("unstable:");
    expect(html).toContain("Nothing was uploaded");
    expect(cap.stdout).toContain("not resolved");
    expect(api.seen.every((s) => s.method === "GET")).toBe(true);
  }, 60_000);

  test("a stable page reports stable and exits 0; --resolve then marks it resolved", async () => {
    const [cwd, api, cap] = [await project(), server(), capture()];
    const code = await run(
      flakeArgs("f2", "--runs", "3", "--resolve", "--note", "fonts pinned"),
      cap.io,
      { fetch: api.fetch, cwd, env },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toContain("stable: all 3 runs rendered the same");
    expect(cap.stdout).toContain("resolved f2");
    const post = api.seen.find((s) => s.method === "POST");
    expect(post?.path).toBe("/api/v1/flakes/f2/resolve");
    expect(JSON.parse(post?.body ?? "")).toEqual({ note: "fonts pinned" });
  }, 60_000);

  test("--write writes only the change the user picks, and nothing on an empty answer", async () => {
    const cwd = await project({ animations: false });
    const path = join(cwd, "pixelslash.config.json");
    const before = await Bun.file(path).text();
    const asked: string[] = [];
    const none = capture();
    const ask = (answer: string) => async (q: string) => {
      asked.push(q);
      return answer;
    };
    const deps = { fetch: server().fetch, cwd, env };
    expect(
      await run(flakeArgs("f1", "--runs", "3", "--write"), none.io, { ...deps, ask: ask("") }),
    ).toBe(UNSTABLE_EXIT);
    expect(none.stdout).toContain("nothing written");
    expect(await Bun.file(path).text()).toBe(before);

    const one = capture();
    await run(flakeArgs("f1", "--runs", "3", "--write"), one.io, { ...deps, ask: ask("1") });
    expect(asked[1]).toContain("Write which change");
    const config: unknown = JSON.parse(await Bun.file(path).text());
    expect(config).toMatchObject({ stabilise: { animations: true } });
    expect(one.stdout).toContain("wrote stabilise.animations = true");
  }, 60_000);

  test("--write adds the ignore area to the route's variant", async () => {
    const cwd = await project();
    const path = join(cwd, "pixelslash.config.json");
    const cap = capture();
    // 1 is the ignore area (stabilise is all on), 2 is flaky: "skip".
    await run(flakeArgs("f1", "--runs", "3", "--write"), cap.io, {
      fetch: server().fetch,
      cwd,
      env,
      ask: async () => "1",
    });
    const config: unknown = JSON.parse(await Bun.file(path).text());
    expect(config).toMatchObject({
      routes: [
        "/",
        {
          path: "/random",
          variants: { small: { ignore: [{ x: expect.any(Number), width: expect.any(Number) }] } },
        },
      ],
    });
  }, 60_000);

  test("usage errors exit 2", async () => {
    const [cwd, api] = [await project(), server()];
    const cases = [
      ["flake"],
      flakeArgs("f1", "--runs", "1"),
      flakeArgs("f1", "--note", "x"),
      flakeArgs("f1", "--resolve", "--note", "x".repeat(201)),
      flakeArgs("f1", "--bogus", "1"),
    ];
    for (const argv of cases) {
      const cap = capture();
      expect(await run(argv, cap.io, { fetch: api.fetch, cwd, env })).toBe(2);
    }
  }, 60_000);
});
