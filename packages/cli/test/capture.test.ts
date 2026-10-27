import { afterAll, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { libraryProject, PAGES } from "../../engine/test/composition-fixtures.ts";
import { run } from "../src/run.ts";
import { FIXTURES, capture, cleanup, tmp } from "./support.ts";

afterAll(cleanup);

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

describe("pixelslash capture", () => {
  test("starts the app from the config, captures every route × variant, stops it", async () => {
    const dir = await tmp();
    const config = join(dir, "pixelslash.config.json");
    const port = 4800 + Math.floor(Math.random() * 500);
    const serve = join(FIXTURES, "..", "scripts", "serve-capture-fixture.ts");
    await Bun.write(
      config,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${port}`,
        start: { command: `bun ${serve} ${port}` },
        routes: ["/", "/motion"],
        variants: [
          { name: "small", viewport: { width: 400, height: 300 } },
          { name: "dark", theme: "dark" },
        ],
      }),
    );
    const cap = capture();
    const code = await run(
      ["capture", "--config", config, "--out", join(dir, "out")],
      cap.io,
      pinned,
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/pixelslash: 4 snapshots/);
    expect(cap.stdout).toContain('"image":"version:test"');
    expect(cap.stdout).toContain(join(dir, "out", "manifest.json"));
    expect(await Bun.file(join(dir, "out", "motion", "dark.png")).exists()).toBe(true);
    const after = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    // The start command is stopped after the run.
    expect(after).toBeUndefined();
  }, 60_000);

  test("a start command that dies before ready fails with exit 1", async () => {
    const dir = await tmp();
    const config = join(dir, "c.json");
    await Bun.write(
      config,
      JSON.stringify({
        baseUrl: "http://127.0.0.1:9",
        start: { command: "exit 3" },
        routes: ["/"],
      }),
    );
    const cap = capture();
    const code = await run(
      ["capture", "--config", config, "--out", join(dir, "out")],
      cap.io,
      pinned,
    );
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/start command exited \(code 3\)/);
  });

  test("a taken ready URL fails with exit 1 and writes no manifest", async () => {
    const dir = await tmp();
    const config = join(dir, "c.json");
    const other = Bun.serve({ port: 0, fetch: () => new Response("another worktree") });
    try {
      await Bun.write(
        config,
        JSON.stringify({
          baseUrl: `http://127.0.0.1:${other.port}`,
          start: { command: "sleep 30" },
          routes: ["/"],
        }),
      );
      const cap = capture();
      const code = await run(
        ["capture", "--config", config, "--out", join(dir, "out")],
        cap.io,
        pinned,
      );
      expect(code).toBe(1);
      expect(cap.stderr).toMatch(/something already answers on http:\/\/127\.0\.0\.1:\d+; stop it/);
      expect(await Bun.file(join(dir, "out", "manifest.json")).exists()).toBe(false);
    } finally {
      await other.stop(true);
    }
  });

  test("a bad flag or a bad config is a usage error, exit 2", async () => {
    const cap = capture();
    expect(await run(["capture", "--live", "x"], cap.io, pinned)).toBe(2);
    expect(cap.stderr).toContain("pixelslash capture [--config FILE]");
    const dir = await tmp();
    const config = join(dir, "c.json");
    await Bun.write(
      config,
      JSON.stringify({ baseUrl: "http://x", routes: ["/"], variants: [{ browser: "webkit" }] }),
    );
    const bad = capture();
    expect(await run(["capture", "--config", config], bad.io, pinned)).toBe(2);
    expect(bad.stderr).toMatch(/variants\[0\]\.browser/);
  });
});

describe("pixelslash capture, media (PS-230)", () => {
  test("warns on stderr and carries the rect in --json, per shot; a page without media has none", async () => {
    const pages: Record<string, string> = {
      "/video": `<video style="position:absolute;left:580px;top:36px;width:112px;height:118px"></video>`,
      "/plain": "<p>no media</p>",
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new Response(pages[new URL(req.url).pathname] ?? "", {
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      const dir = await tmp();
      const config = join(dir, "pixelslash.config.json");
      await Bun.write(
        config,
        JSON.stringify({
          baseUrl: `http://127.0.0.1:${server.port}`,
          routes: [
            { path: "/video", name: "clip" },
            { path: "/plain", name: "plain" },
          ],
          variants: [{ name: "small", viewport: { width: 800, height: 300 } }],
        }),
      );
      const json = capture();
      const argv = ["capture", "--config", config, "--out", join(dir, "out"), "--json"];
      expect(await run(argv, json.io, pinned)).toBe(0);
      expect(json.stderr.split("\n").filter((l) => l.startsWith("warning:"))).toEqual([
        "warning: <video> at 580,36 112x118 on clip (small) — media renders unreliably; add an exclusion zone (route.ignore) for this shot",
      ]);
      const shots: { name: string; media: unknown }[] = JSON.parse(json.stdout).shots;
      expect(shots.map((s) => [s.name, s.media])).toEqual([
        ["clip", [{ tag: "video", x: 580, y: 36, width: 112, height: 118 }]],
        ["plain", []],
      ]);
    } finally {
      await server.stop(true);
    }
  }, 60_000);
});

describe("pixelslash capture, composition-only (ob 1850)", () => {
  test("prints the gap list's counts and link, puts the findings in --json, and still exits 0", async () => {
    const project = await libraryProject();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new Response(Reflect.get(PAGES, new URL(req.url).pathname.slice(1)) ?? "", {
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      const config = join(project, "pixelslash.config.json");
      await Bun.write(
        config,
        JSON.stringify({
          baseUrl: `http://127.0.0.1:${server.port}`,
          routes: ["/stray", "/marked"],
          variants: [{ name: "desktop", viewport: { width: 800, height: 400 } }],
          composition: { library: "@acme/ui", name: "Acme UI" },
        }),
      );
      const out = join(project, "out");
      const cap = capture();
      expect(await run(["capture", "--config", config, "--out", out], cap.io, pinned)).toBe(0);
      expect(cap.stdout).toContain(
        `gaps: 1 styled outside the library, 1 special case: file://${join(out, "gaps.html")}`,
      );
      const json = capture();
      const argv = ["capture", "--config", config, "--out", out, "--json"];
      expect(await run(argv, json.io, pinned)).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.gaps).toBe(join(out, "gaps.html"));
      expect(parsed.shots[0].composition.gaps[0].classes).toEqual(["mt-7"]);
    } finally {
      await server.stop(true);
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);
});
