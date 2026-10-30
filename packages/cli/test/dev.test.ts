import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devStore, latestIteration, liveSession } from "@pixelslash/engine";
import { afterAll, describe, expect, test } from "vitest";
import type { KeyInput } from "../src/dev-loop.ts";
import { run } from "../src/run.ts";
import { capture, cleanup, solidPng } from "./support.ts";
import { FIGMA, featureProject, project, until } from "./dev-support.ts";
import { gitRepo } from "./upload-support.ts";

afterAll(cleanup);

/** `pixelslash dev` (ob 1740): the one-shot JSON, main's baselines, attaching, nothing uploaded. */

const SERVER = "https://ps.example";
const pinned = { PIXELSLASH_IMAGE_VERSION: "test" };
const withToken = { ...pinned, PIXELSLASH_TOKEN: "psci_t" };
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

  test("SIGTERM ends it like q, and the next dev starts its own session (ob 1761)", async () => {
    const { cwd } = await project();
    const store = devStore(cwd);
    const bin = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, bin, "dev", "index"], {
      cwd,
      env: { ...process.env, ...pinned },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const owner = await until(async () => (await liveSession(store))?.url ?? undefined);
    expect(await until(async () => ((await latestIteration(store)) ? true : undefined))).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(join(store.root, "session.json")).exists()).toBe(false);
    expect(await fetch(owner).catch(() => null)).toBeNull();
    // Before, Playwright's handler closed the browser and the process lived on with the lock:
    // this run attached to it and failed on "browser has been closed".
    const next = capture();
    expect(
      await run(["dev", "index", "--once", "--json"], next.io, { ...base, cwd, env: pinned }),
    ).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ page: null, id: "000002" });
    expect(next.stderr).not.toMatch(/closed|failed/);
  }, 60_000);
});

describe("pixelslash dev, a feature's spec and refs (ob 1741)", () => {
  test("dev spec --json is the spec text and the refs, inline images capped at 1024 px", async () => {
    const { cwd } = await featureProject();
    const cap = capture();
    expect(await run(["dev", "spec", "--json"], cap.io, { ...base, cwd, env: pinned })).toBe(0);
    expect(cap.stderr).toContain(`skip: no figma token (${FIGMA})`);
    const out = JSON.parse(cap.stdout);
    expect(out.target).toBe("index");
    expect(out.spec).toEqual({
      path: join(cwd, "cart.md"),
      text: "# Cart\nThe total sits under the list.",
    });
    expect(out.refs).toHaveLength(2);
    expect(out.refs[0]).toMatchObject({
      kind: "png",
      file: join(cwd, "cart.png"),
      size: { width: 2048, height: 100 },
    });
    const inline = Buffer.from(out.refs[0].image.replace("data:image/png;base64,", ""), "base64");
    expect(inline.readUInt32BE(16)).toBe(1024);
    expect(out.refs[1]).toMatchObject({
      kind: "figma",
      file: null,
      skip: "no figma token",
      image: null,
    });
    expect(cap.stdout).not.toMatch(/score|match/i);
  });

  test("--judge with a feature and no --ds lists differences, and with no judge says skip", async () => {
    const { cwd } = await featureProject();
    const deps = { ...base, cwd, env: pinned };
    const json = capture();
    expect(await run(["dev", "index", "--once", "--json", "--judge"], json.io, deps)).toBe(0);
    const it = JSON.parse(json.stdout);
    expect(it.differences).toEqual({ status: "skipped", reason: "no judge", items: [] });
    expect(it.judge).toBeNull();
    const text = capture();
    expect(await run(["dev", "index", "--once", "--judge"], text.io, deps)).toBe(0);
    expect(text.stdout).toContain("skip: no judge");
    const latest = capture();
    expect(await run(["dev", "latest", "--json"], latest.io, deps)).toBe(0);
    expect(JSON.parse(latest.stdout).differences).toMatchObject({ status: "skipped" });
  }, 60_000);

  test("--judge with neither --ds nor a feature is a usage error", async () => {
    const { cwd } = await project();
    const cap = capture();
    const code = await run(["dev", "index", "--once", "--judge"], cap.io, {
      ...base,
      cwd,
      env: pinned,
    });
    expect(code).toBe(2);
    expect(cap.stderr).toContain("--judge needs --ds DIR");
  });
});
