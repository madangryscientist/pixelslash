import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devStore, liveSession } from "@pixelslash/engine";
import { afterAll, describe, expect, test } from "vitest";
import type { KeyInput } from "../src/dev-loop.ts";
import { run } from "../src/run.ts";
import { capture, cleanup, solidPng } from "./support.ts";
import { gitRepo } from "./upload-support.ts";

afterAll(cleanup);

/** `pixelslash dev` (ob 1740): the one-shot JSON, main's baselines, attaching, nothing uploaded. */

const SERVER = "https://ps.example";
const pinned = { PIXELSLASH_IMAGE_VERSION: "test" };
const withToken = { ...pinned, PIXELSLASH_TOKEN: "psci_t" };
const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

type Seen = { method: string; path: string };

/** The review server, read-only: it picks a red baseline for every key it is asked about. */
function server() {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push({ method: init?.method ?? "GET", path });
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
        removed: [],
      });
    }
    if (path.startsWith("/images/")) return new Response(solidPng(400, 300, [200, 0, 0, 255]));
    return Response.json({ error: "not here" }, { status: 404 });
  };
  return { fetch, seen };
}

/** A git repo with a config whose one route is `page.html` in the repo, read on every request. */
async function project() {
  const cwd = await gitRepo();
  const file = join(cwd, "page.html");
  await writeFile(file, `<body style="margin:0;background:#fff"><p>one</p></body>`);
  const page = Bun.serve({
    port: 0,
    fetch: async () =>
      new Response(await readFile(file, "utf8"), { headers: { "content-type": "text/html" } }),
  });
  servers.push(page);
  await Bun.write(
    join(cwd, "pixelslash.config.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${page.port}`,
      routes: ["/"],
      variants: [{ name: "small", viewport: { width: 400, height: 300 } }],
    }),
  );
  return { cwd, file };
}

/** Keys a test presses. */
function keyboard(): KeyInput & { press: (k: string) => void } {
  const fns = new Set<(chunk: string) => void>();
  return {
    on: (_e, fn) => fns.add(fn),
    off: (_e, fn) => fns.delete(fn),
    press: (k) => {
      for (const fn of fns) fn(k);
    },
  };
}

async function until<T>(get: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

const base = { listFonts: async () => [], which: () => null };

describe("pixelslash dev --once", () => {
  test("--json holds the regions, pixels, timings, files and judge, and nothing left", async () => {
    const [{ cwd, file }, api] = [await project(), server()];
    const deps = { ...base, cwd, env: withToken, fetch: api.fetch };
    const first = capture();
    expect(await run(["dev", "index", "--once", "--json"], first.io, deps)).toBe(0);
    await writeFile(file, `<body style="margin:0;background:#fff"><p>two, longer</p></body>`);
    const second = capture();
    const argv = ["dev", "index", "--once", "--json", "--judge", "--ds", cwd];
    expect(await run(argv, second.io, deps)).toBe(0);
    const out: unknown = JSON.parse(second.stdout);
    expect(out).toMatchObject({
      uploaded: false,
      page: null,
      id: "000002",
      target: "index",
      against: { kind: "previous", iteration: "000001" },
      note: null,
      counts: { changed: 1, unchanged: 0, new: 0, removed: 0 },
      judge: { status: "skipped", reason: "no judge", notes: [] },
    });
    const it = JSON.parse(second.stdout);
    expect(it.regions).toBeGreaterThan(0);
    expect(it.changedPixels).toBeGreaterThan(0);
    expect(it.timings.settleMs).toBeGreaterThan(0);
    expect(it.timings.oursMs).toBeCloseTo(it.timings.totalMs - it.timings.settleMs, 3);
    expect(await Bun.file(it.shots[0].files.diff).exists()).toBe(true);
    expect(await Bun.file(it.shots[0].files.shot).exists()).toBe(true);
    expect(api.seen).toEqual([]);
    expect(await readFile(join(cwd, ".pixelslash", "dev", ".gitignore"), "utf8")).toBe("*\n");
    expect(await Bun.file(join(cwd, ".gitignore")).exists()).toBe(false);
  }, 60_000);

  test("--against main reads main's baselines and writes nothing to the server", async () => {
    const [{ cwd }, api, cap] = [await project(), server(), capture()];
    const argv = ["dev", "index", "--once", "--json", "--against", "main", "--server", SERVER];
    const code = await run(argv, cap.io, { ...base, cwd, env: withToken, fetch: api.fetch });
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout)).toMatchObject({
      against: { kind: "main", iteration: null },
      note: null,
      counts: { changed: 1 },
    });
    expect(api.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/v1/baselines",
      "GET /images/s0.png",
    ]);
  }, 60_000);

  test("--against main without credentials says so and diffs locally", async () => {
    const [{ cwd }, api, cap] = [await project(), server(), capture()];
    const argv = ["dev", "index", "--once", "--json", "--against", "main"];
    const code = await run(argv, cap.io, {
      ...base,
      cwd,
      env: pinned,
      fetch: api.fetch,
    });
    expect(code).toBe(0);
    const out = JSON.parse(cap.stdout);
    expect(out.against.kind).toBe("none");
    expect(out.note).toMatch(/^no credentials for main's baselines/);
    expect(api.seen).toEqual([]);
  }, 60_000);

  test("a URL that is down fails with exit 2 and starts nothing", async () => {
    const cwd = await gitRepo();
    const gone = Bun.serve({ port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${gone.port}/`;
    await gone.stop(true);
    const cap = capture();
    expect(await run(["dev", "--url", url, "--once"], cap.io, { ...base, cwd })).toBe(2);
    expect(cap.stderr).toMatch(/is not answering .*does not start a dev server/);
  });
});

describe("pixelslash dev", () => {
  test("re-runs on a save, and a second dev attaches to the live session", async () => {
    const { cwd, file } = await project();
    const [keys, cap] = [keyboard(), capture()];
    const store = devStore(cwd);
    const first = run(["dev", "index"], cap.io, { ...base, cwd, env: pinned, keys });
    try {
      const owner = await until(async () =>
        (await liveSession(store))?.url ? await liveSession(store) : undefined,
      );
      await until(async () => (cap.stdout.includes("#1 vs") ? true : undefined));
      await writeFile(file, `<body style="margin:0;background:#fff"><h1>saved</h1></body>`);
      await until(async () => (cap.stdout.includes("#2 vs #1") ? true : undefined));
      expect(cap.stdout).toMatch(
        /#2 vs #1: \d+ regions changed · \d+ px · ours \d+\.\d s · settle \d+\.\d s · http:\/\/127\.0\.0\.1:\d+/,
      );

      const once = capture();
      const second = await run(["dev", "--once", "--json"], once.io, {
        ...base,
        cwd,
        keys: keyboard(),
      });
      expect(second).toBe(0);
      expect(JSON.parse(once.stdout)).toMatchObject({
        page: owner?.url,
        against: { kind: "previous" },
      });

      const elsewhere = capture();
      expect(await run(["dev", "other", "--once", "--json"], elsewhere.io, { ...base, cwd })).toBe(
        2,
      );
      expect(elsewhere.stderr).toMatch(/session is on index, not other/);

      const otherKeys = keyboard();
      const attached = capture();
      const following = run(["dev"], attached.io, { ...base, cwd, keys: otherKeys });
      await until(async () =>
        attached.stdout.includes("attached to the session on index") ? true : undefined,
      );
      otherKeys.press("q");
      expect(await following).toBe(0);
    } finally {
      keys.press("q");
    }
    expect(await first).toBe(0);
    expect(await liveSession(store)).toBeUndefined();
  }, 90_000);
});
