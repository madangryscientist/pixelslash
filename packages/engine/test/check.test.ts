import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { checkAgainstServer } from "../src/check.ts";
import { parseConfig } from "../src/config.ts";
import type { CaptureSession } from "../src/snapshot.ts";
import { type Call, fakeServer } from "./fake-server.ts";
import { FP, cleanup, repo, tmp } from "./upload-fixtures.ts";

afterAll(cleanup);

/** `pixelslash check` against a stubbed server (ob 1732): counts, a mismatch, a flake, no writes. */

/** A 16x16 white PNG, with a red square at (x, 4) when `at` is given. */
function png(at?: number): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  img.data.fill(255);
  if (at !== undefined)
    for (let y = 4; y < 10; y++)
      for (let x = at; x < at + 4; x++) img.data.set([220, 30, 30, 255], (y * 16 + x) << 2);
  return PNG.sync.write(img);
}

const PINNED = { ...FP, image: "version:pinned" };
const picked = (id: string, fingerprint: object = FP) => ({
  id,
  image_url: `/images/orgs/o/${id}.png?exp=1&sig=s`,
  fingerprint,
  ignore: [],
});
const IMAGES: Record<string, Buffer> = { white: png(), red: png(4), pinned: png() };

/** The server's pick per route name; anything it is not told about has no baseline. */
const PICKS: Record<string, object> = {
  same: { baseline: picked("white"), carry: null, accepted: null },
  changed: { baseline: picked("white"), carry: null, accepted: null },
  flaky: { baseline: picked("white"), carry: null, accepted: null },
  drift: { baseline: picked("pinned", PINNED), carry: null, accepted: null },
  // An undecided change the shot still matches is kept as its baseline, as finalise does.
  carried: { baseline: picked("red"), carry: "red", accepted: picked("white") },
};
const GONE = { name: "gone", platform: "linux", browser: "chromium", viewport: "16x16" };

function server() {
  return fakeServer((c: Call) => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/baselines")) {
      const keys: unknown = Reflect.get(Object(c.body), "keys");
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      return Response.json({
        api_version: 1,
        diff_location: "ci",
        baselines: keys.map((key) => ({
          key,
          ...(PICKS[String(Reflect.get(Object(key), "name"))] ?? {
            baseline: null,
            carry: null,
            accepted: null,
          }),
        })),
        removed: [{ ...GONE, theme: "light" }],
      });
    }
    const id = /\/images\/orgs\/o\/(\w+)\.png/.exec(c.url)?.[1];
    const bytes = id ? IMAGES[id] : undefined;
    if (c.method === "GET" && bytes) return new Response(bytes);
    return new Response("not here", { status: 404 });
  });
}

/** A session that shoots fixed PNGs: `flaky` puts its square somewhere new on every capture. */
function session(): CaptureSession {
  const config = parseConfig({
    baseUrl: "http://127.0.0.1:1",
    routes: ["/same", "/changed", "/new", "/flaky", "/drift", "/carried"],
    variants: [{ name: "desktop", viewport: { width: 16, height: 16 } }],
  });
  let flakes = 0;
  const shots: Record<string, () => Buffer> = {
    changed: () => png(4),
    flaky: () => png(2 + 4 * (flakes++ % 3)),
    carried: () => png(4),
  };
  return {
    config,
    routes: config.routes,
    fingerprint: FP,
    shoot: async (route) => ({ png: (shots[route.name] ?? png)(), ignore: [] }),
    close: async () => {},
  };
}

async function check(only?: string[]) {
  const { dir: cwd } = await repo(1, 1);
  const fake = server();
  const result = await checkAgainstServer(
    session(),
    {
      out: await tmp(),
      server: "https://ps.example",
      token: "psci_t",
      git: { cwd, baseBranch: "main" },
      only,
      flakeRetries: 2,
    },
    { fetch: fake.fetch, env: {} },
  );
  return { result, calls: fake.calls };
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("checkAgainstServer", () => {
  test("counts what changed against the server's pick and writes the compare report", async () => {
    const { result } = await check();
    expect(names(result.changed)).toEqual(["changed", "flaky"]);
    expect(names(result.unchanged)).toEqual(["same", "drift", "carried"]);
    expect(names(result.added)).toEqual(["new"]);
    expect(names(result.removed)).toEqual(["gone"]);
    const index = await Bun.file(result.indexPath).text();
    expect(index).toContain("PixelSlash check");
    expect(index).toContain("a preview, not a stored result. Nothing was uploaded.");
    const changed = result.shots.find((s) => s.name === "changed");
    expect(changed?.regions.length).toBeGreaterThan(0);
    expect(await Bun.file(changed?.files.report ?? "").exists()).toBe(true);
    expect(await Bun.file(changed?.files.main ?? "").exists()).toBe(true);
  });

  test("only reads the server: one baselines POST and image GETs, no PUT, no build", async () => {
    const { calls } = await check();
    const sent = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(sent[0]).toBe("POST /api/v1/baselines");
    expect(sent.slice(1).every((s) => s.startsWith("GET /images/"))).toBe(true);
    expect(calls[0]?.body).toMatchObject({ branch: "feat", keys: expect.any(Array) });
  });

  test("a baseline from another environment is said per shot, and diffed anyway", async () => {
    const { result } = await check();
    expect(result.mismatched.map((r) => [r.name, r.mismatch])).toEqual([["drift", ["image"]]]);
    expect(result.shots.find((s) => s.name === "drift")?.mismatch).toEqual(["image"]);
    expect(await Bun.file(result.indexPath).text()).toContain("drift");
  });

  test("a shot that differs from itself on capture is reported flaky", async () => {
    const { result } = await check();
    expect(result.flaky.map((f) => f.entry.name)).toEqual(["flaky"]);
    expect(result.shots.find((s) => s.name === "flaky")?.flaky).toEqual({ runs: 3, differed: 2 });
    expect(result.shots.find((s) => s.name === "changed")?.flaky).toBeUndefined();
    expect(result.flakeReport).toBeDefined();
    expect(await Bun.file(result.indexPath).text()).toContain("flaky: 2 of 3 captures differed");
  });

  test("--only captures just those routes, and removes nothing else", async () => {
    const { result } = await check(["changed"]);
    expect(result.shots.map((s) => [s.name, s.status])).toEqual([["changed", "changed"]]);
    await expect(check(["nope"])).rejects.toThrow(/--only: no route nope/);
  });
});
