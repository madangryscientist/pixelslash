import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "../src/compare.ts";
import type { CapturePage, ProcLike, SpawnProc } from "../src/compare.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
const PAGES = join(FIXTURES, "pages");
const DS = join(FIXTURES, "ds");
const temps: string[] = [];
const servers: Array<{ stop(): void }> = [];

afterAll(() => {
  for (const s of servers) s.stop();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visual-compare-"));
  temps.push(dir);
  return dir;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write(s: string) { stdout += s; } },
      stderr: { write(s: string) { stderr += s; } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

const enc = new TextEncoder();

function fakeProc(stdoutText: string, stderrText = "", exitCode: number | null = 0): ProcLike {
  const stream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text) c.enqueue(enc.encode(text));
        c.close();
      },
    });
  return {
    stdout: stream(stdoutText),
    stderr: stream(stderrText),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode: null,
  };
}

function imagesAfterFlag(cmd: string[]): string[] {
  const i = cmd.indexOf("--image");
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < cmd.length; j++) {
    if (cmd[j]!.startsWith("-")) break;
    out.push(cmd[j]!);
  }
  return out;
}

function componentOf(cmd: string[]): string {
  const images = imagesAfterFlag(cmd);
  return basename(images[1] ?? "").replace(/\.png$/i, "");
}

function pageOf(cmd: string[]): "live" | "local" | "other" {
  const page = imagesAfterFlag(cmd)[0] ?? "";
  if (page.includes("live")) return "live";
  if (page.includes("local")) return "local";
  return "other";
}

function newMissSpawn(): SpawnProc {
  return (cmd) => {
    const component = componentOf(cmd);
    const page = pageOf(cmd);
    if (component === "button") return fakeProc("VIOLATION fill is red not blue");
    if (component === "card" && page === "local") return fakeProc("VIOLATION card has no border");
    return fakeProc("OK");
  };
}

function identicalSpawn(): SpawnProc {
  return (cmd) => {
    const component = componentOf(cmd);
    if (component === "button") return fakeProc("VIOLATION fill is red not blue");
    return fakeProc("OK");
  };
}

async function servePages(): Promise<{ url(file: string): string; stop(): void }> {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, "");
      const file = Bun.file(join(PAGES, name));
      if (await file.exists()) return new Response(file, { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  const handle = { url: (file: string) => `http://127.0.0.1:${server.port}/${file}`, stop: () => server.stop(true) };
  servers.push(handle);
  return handle;
}

function pngWidth(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(16);
}

describe("fixture run", () => {
  test("live has 1 DS miss, local adds 1 new miss → exit 1, HTML names the new miss", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      ["--live", pages.url("live.html"), "--local", pages.url("local.html"), "--ds", DS, "--out", out],
      cap.io,
      { spawn: newMissSpawn() },
    );
    expect(code).toBe(1);
    expect(cap.stdout).toMatch(/1 new/);
    expect(cap.stdout).toContain("card");
    expect(cap.stdout).toMatch(/file:\/\//);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).not.toContain("No new violations");
    expect(html).toMatch(/new[\s\S]*card/i);
    expect(html).toMatch(/1 already on Main/);
    expect(html).toMatch(/1 new on Branch/);
    expect(html).toContain("<figcaption>Main</figcaption>");
    expect(html).toContain("<figcaption>Branch</figcaption>");
    expect(html).not.toContain("<figcaption>live</figcaption>");
    expect(html).not.toContain("<figcaption>local</figcaption>");
    const alreadyHtml = html.match(/<section class="already">[\s\S]*?<\/section>/)?.[0] ?? "";
    const newHtml = html.match(/<section class="new">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(alreadyHtml).toContain("<h3>button</h3>");
    expect(newHtml).toContain("<h3>card</h3>");
    expect(html).toContain("live.png");
    expect(html).toContain("local.png");
    expect(html).toContain("button.png");
    expect(existsSync(join(out, "live.png"))).toBe(true);
    expect(existsSync(join(out, "local.png"))).toBe(true);
    expect(existsSync(join(out, "ds/button.png"))).toBe(true);
    const live = new Uint8Array(await Bun.file(join(out, "live.png")).arrayBuffer());
    expect(pngWidth(live)).toBe(1280);
  }, 30_000);

  test("identical live/local → exit 0", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const live = pages.url("live.html");
    const code = await run(
      ["--live", live, "--local", live, "--ds", DS, "--out", out],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/0 new/);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("No new violations");
  }, 30_000);
});

describe("capture", () => {
  test("down URL fails and does not start nx", async () => {
    const dir = await tmp();
    const cap = capture();
    const code = await run(
      [
        "--live",
        "http://127.0.0.1:1/",
        "--local",
        "http://127.0.0.1:1/",
        "--ds",
        DS,
        "--out",
        join(dir, "out"),
      ],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/capture failed|down|refused|ERR_/i);
    expect(cap.stderr).not.toMatch(/\bnx\b/i);
    expect(cap.stderr).not.toMatch(/dev server/i);
  }, 15_000);

  test("--width overrides the default", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    await run(
      [
        "--live",
        pages.url("live.html"),
        "--local",
        pages.url("live.html"),
        "--ds",
        DS,
        "--out",
        out,
        "--width",
        "800",
      ],
      cap.io,
      { spawn: identicalSpawn() },
    );
    const live = new Uint8Array(await Bun.file(join(out, "live.png")).arrayBuffer());
    expect(pngWidth(live)).toBe(800);
  }, 30_000);
});

describe("png shots", () => {
  test("--live-png --local-png skip Playwright and judge like URLs", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn: newMissSpawn() },
    );
    expect(code).toBe(1);
    expect(cap.stdout).toMatch(/1 new/);
    expect(cap.stdout).toContain("card");
    expect(existsSync(join(out, "live.png"))).toBe(true);
    expect(existsSync(join(out, "local.png"))).toBe(true);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("<figcaption>Main</figcaption>");
    expect(html).toContain("<figcaption>Branch</figcaption>");
    expect(html).toMatch(/new[\s\S]*card/i);
    const alreadyHtml = html.match(/<section class="already">[\s\S]*?<\/section>/)?.[0] ?? "";
    const newHtml = html.match(/<section class="new">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(alreadyHtml).toContain("<h3>button</h3>");
    expect(newHtml).toContain("<h3>card</h3>");
  });

  test("missing judge writes HTML, prints skip, exit 0, no fake violations", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/skip: no judge/);
    expect(cap.stdout).not.toMatch(/new on branch/);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("<figcaption>Main</figcaption>");
    expect(html).toContain("<figcaption>Branch</figcaption>");
    expect(html).toContain("live.png");
    expect(html).toContain("local.png");
    expect(html).toContain("No violations on Main.");
    expect(html).toContain("No new violations");
    expect(html).not.toContain("<h3>");
    expect(existsSync(join(out, "live.png"))).toBe(true);
    expect(existsSync(join(out, "ds/button.png"))).toBe(true);
  });

  test("mlx preferred when ollama is also present", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      return fakeProc("OK");
    };
    const which = (bin: string) =>
      bin === "mlx_vlm.generate" || bin === "ollama" ? `/bin/${bin}` : null;
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn, which },
    );
    expect(code).toBe(0);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]![0]).toBe("mlx_vlm.generate");
    expect(cmds.some((c) => c[0] === "ollama")).toBe(false);
  });

  test("ollama when mlx missing: argv is ollama run qwen2.5vl", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      return fakeProc("OK");
    };
    const which = (bin: string) => (bin === "ollama" ? "/bin/ollama" : null);
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn, which },
    );
    expect(code).toBe(0);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]!.slice(0, 3)).toEqual(["ollama", "run", "qwen2.5vl"]);
    expect(cmds[0]![3]).toBe(join(out, "live.png"));
    expect(cmds[0]![4]).toMatch(/\.png$/);
    expect(cmds.every((c) => c[0] === "ollama")).toBe(true);
  });

  test("missing live-png file exit 2", async () => {
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(tmpdir(), "visual-compare-no-live.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
      ],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/live-png not found/);
  });
});

describe("routes", () => {
  test("N routes → 2N captures, 2N×|ds| judge calls, HTML index", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const liveDir = join(dir, "live");
    const localDir = join(dir, "local");
    await Bun.write(join(liveDir, "index.png"), Bun.file(join(DS, "button.png")));
    await Bun.write(join(liveDir, "pricing.png"), Bun.file(join(DS, "button.png")));
    await Bun.write(join(localDir, "index.png"), Bun.file(join(DS, "card.png")));
    await Bun.write(join(localDir, "pricing.png"), Bun.file(join(DS, "button.png")));
    const routes = join(dir, "routes.txt");
    await Bun.write(routes, "/\n/pricing\n");
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      const page = imagesAfterFlag(cmd)[0] ?? "";
      const component = componentOf(cmd);
      if (component === "button") return fakeProc("VIOLATION fill is red not blue");
      if (component === "card" && page.includes("/index/") && page.includes("local")) {
        return fakeProc("VIOLATION card has no border");
      }
      return fakeProc("OK");
    };
    const cap = capture();
    const code = await run(
      [
        "--live-png-dir",
        liveDir,
        "--local-png-dir",
        localDir,
        "--routes",
        routes,
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn },
    );
    const dsCount = (await readdir(DS)).filter((n) => n.toLowerCase().endsWith(".png")).length;
    expect(code).toBe(1);
    expect(cmds.length).toBe(2 * 2 * dsCount);
    expect(existsSync(join(out, "index/live.png"))).toBe(true);
    expect(existsSync(join(out, "index/local.png"))).toBe(true);
    expect(existsSync(join(out, "pricing/live.png"))).toBe(true);
    expect(existsSync(join(out, "pricing/local.png"))).toBe(true);
    expect(cap.stdout).toMatch(/1 new/);
    expect(cap.stdout).toContain("card");
    expect(cap.stdout).toMatch(/file:\/\//);
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain("href=\"index/report.html\"");
    expect(index).toContain("href=\"pricing/report.html\"");
    expect(index).toContain("/");
    expect(index).toContain("/pricing");
    const home = await Bun.file(join(out, "index/report.html")).text();
    const pricing = await Bun.file(join(out, "pricing/report.html")).text();
    expect(home).toMatch(/new[\s\S]*card/i);
    expect(pricing).toContain("No new violations");
  });

  test("missing judge: skip, HTML index, no fake violations", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const liveDir = join(dir, "live");
    const localDir = join(dir, "local");
    await Bun.write(join(liveDir, "index.png"), Bun.file(join(DS, "button.png")));
    await Bun.write(join(localDir, "index.png"), Bun.file(join(DS, "card.png")));
    const routes = join(dir, "routes.txt");
    await Bun.write(routes, "/\n");
    const cap = capture();
    const code = await run(
      [
        "--live-png-dir",
        liveDir,
        "--local-png-dir",
        localDir,
        "--routes",
        routes,
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/skip: no judge/);
    expect(cap.stdout).not.toMatch(/new on branch/);
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain("href=\"index/report.html\"");
    const html = await Bun.file(join(out, "index/report.html")).text();
    expect(html).toContain("No violations on Main.");
    expect(html).toContain("No new violations");
    expect(html).not.toContain("<h3>");
  });

  test("URL origins + routes capture each path, no nx", async () => {
    const liveSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const file = path === "/pricing" ? "live.html" : path === "/" ? "live.html" : null;
        if (!file) return new Response("not found", { status: 404 });
        return new Response(Bun.file(join(PAGES, file)), { headers: { "content-type": "text/html" } });
      },
    });
    const localSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const file = path === "/pricing" ? "live.html" : path === "/" ? "local.html" : null;
        if (!file) return new Response("not found", { status: 404 });
        return new Response(Bun.file(join(PAGES, file)), { headers: { "content-type": "text/html" } });
      },
    });
    servers.push({ stop: () => liveSrv.stop(true) }, { stop: () => localSrv.stop(true) });
    const dir = await tmp();
    const out = join(dir, "out");
    const routes = join(dir, "routes.txt");
    await Bun.write(routes, "/\n/pricing\n");
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      const page = imagesAfterFlag(cmd)[0] ?? "";
      const component = componentOf(cmd);
      if (component === "button") return fakeProc("VIOLATION fill is red not blue");
      if (component === "card" && page.includes("/index/") && page.includes("local")) {
        return fakeProc("VIOLATION card has no border");
      }
      return fakeProc("OK");
    };
    const cap = capture();
    const code = await run(
      [
        "--live",
        `http://127.0.0.1:${liveSrv.port}`,
        "--local",
        `http://127.0.0.1:${localSrv.port}`,
        "--routes",
        routes,
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn },
    );
    const dsCount = (await readdir(DS)).filter((n) => n.toLowerCase().endsWith(".png")).length;
    expect(code).toBe(1);
    expect(cmds.length).toBe(2 * 2 * dsCount);
    expect(existsSync(join(out, "index/live.png"))).toBe(true);
    expect(existsSync(join(out, "pricing/local.png"))).toBe(true);
    expect(cap.stderr).not.toMatch(/\bnx\b/i);
    expect(cap.stdout).toMatch(/1 new/);
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain("href=\"index/report.html\"");
    expect(index).toContain("href=\"pricing/report.html\"");
  }, 30_000);

  test("--routes missing file exit 2", async () => {
    const cap = capture();
    const code = await run(
      [
        "--live",
        "http://127.0.0.1:1/",
        "--local",
        "http://127.0.0.1:1/",
        "--routes",
        join(tmpdir(), "visual-compare-no-routes.txt"),
        "--ds",
        DS,
      ],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/routes file not found/);
  });

  test("png-dir without --routes exit 2", async () => {
    const dir = await tmp();
    const cap = capture();
    const code = await run(
      ["--live-png-dir", dir, "--local-png-dir", dir, "--ds", DS],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--routes/);
  });
});

describe("usage", () => {
  test("missing flags exit 2", async () => {
    const cap = capture();
    const code = await run([], cap.io, { spawn: identicalSpawn() });
    expect(code).toBe(2);
    expect(cap.stderr).toContain("--live");
  });

  test("missing ds dir exit 2", async () => {
    const cap = capture();
    const code = await run(
      ["--live", "http://127.0.0.1:1/", "--local", "http://127.0.0.1:1/", "--ds", join(tmpdir(), "visual-compare-no-ds")],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/ds dir not found/);
  });

  test("ds dir with no pngs exit 2", async () => {
    const dir = await tmp();
    const cap = capture();
    const code = await run(
      ["--live", "http://127.0.0.1:1/", "--local", "http://127.0.0.1:1/", "--ds", dir],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/no png/);
  });

  test("invalid --width exit 2", async () => {
    const cap = capture();
    const code = await run(
      ["--live", "http://127.0.0.1:1/", "--local", "http://127.0.0.1:1/", "--ds", DS, "--width", "0"],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--width/);
  });
});

function mlxStdout(answer: string): string {
  return [
    "Prompt: IMAGE 1 is a page screenshot.",
    "Files: ['page.png', 'component.png']",
    "=======",
    answer,
    "=======",
    "Generation: 8 tokens",
    "Peak memory: 1.1 GB",
  ].join("\n");
}

function parseSpawn(): SpawnProc {
  return (cmd) => {
    const component = componentOf(cmd);
    const page = pageOf(cmd);
    if (component === "button") return fakeProc(mlxStdout("VIOLATION fill is red not blue"));
    if (component === "card" && page === "local") return fakeProc(mlxStdout("VIOLATION"));
    return fakeProc(mlxStdout("OK"));
  };
}

const FILE_KEY = "dT3GXFF5uVHQtmn12XgWEI";
const FIGMA_TOKEN = "test-figma-token";

function figmaFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin === "https://api.figma.com") {
      const token = (init?.headers as Record<string, string> | undefined)?.["X-Figma-Token"];
      if (token !== FIGMA_TOKEN) return new Response("unauthorized", { status: 403 });
      if (u.pathname === `/v1/files/${FILE_KEY}`) {
        return Response.json({
          document: {
            id: "0:0",
            name: "Document",
            type: "DOCUMENT",
            children: [
              {
                id: "0:1",
                name: "Page",
                type: "CANVAS",
                children: [
                  { id: "1:1", name: "button", type: "COMPONENT" },
                  { id: "1:2", name: "card", type: "COMPONENT" },
                  { id: "1:3", name: "heading", type: "COMPONENT" },
                ],
              },
            ],
          },
        });
      }
      if (u.pathname === `/v1/images/${FILE_KEY}`) {
        return Response.json({
          err: null,
          images: {
            "1:1": "https://files.example/button.png",
            "1:2": "https://files.example/card.png",
            "1:3": "https://files.example/heading.png",
          },
        });
      }
    }
    if (url === "https://files.example/button.png") return new Response(Bun.file(join(DS, "button.png")));
    if (url === "https://files.example/card.png") return new Response(Bun.file(join(DS, "card.png")));
    if (url === "https://files.example/heading.png") return new Response(Bun.file(join(DS, "heading.png")));
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe("figma file", () => {
  test("--file without token exits 2", async () => {
    const cap = capture();
    const code = await run(
      ["--live", "http://127.0.0.1:1/", "--local", "http://127.0.0.1:1/", "--file", FILE_KEY],
      cap.io,
      { spawn: identicalSpawn(), fetch: figmaFetch(), env: {} },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/FIGMA_TOKEN|--token-path/);
  });

  test("list+raster writes pngs named after components, then new miss → exit 1", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const tokenPath = join(dir, "token");
    await Bun.write(tokenPath, `${FIGMA_TOKEN}\n`);
    const cap = capture();
    const code = await run(
      [
        "--live",
        pages.url("live.html"),
        "--local",
        pages.url("local.html"),
        "--file",
        FILE_KEY,
        "--token-path",
        tokenPath,
        "--out",
        out,
      ],
      cap.io,
      { spawn: newMissSpawn(), fetch: figmaFetch(), env: {} },
    );
    expect(code).toBe(1);
    expect(existsSync(join(out, "ds/button.png"))).toBe(true);
    expect(existsSync(join(out, "ds/card.png"))).toBe(true);
    expect(existsSync(join(out, "ds/heading.png"))).toBe(true);
    expect(cap.stdout).toMatch(/1 new/);
    expect(cap.stdout).toContain("card");
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toMatch(/new[\s\S]*card/i);
  }, 30_000);

  test("identical live/local → exit 0", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const live = pages.url("live.html");
    const code = await run(
      ["--live", live, "--local", live, "--file", FILE_KEY, "--out", out],
      cap.io,
      { spawn: identicalSpawn(), fetch: figmaFetch(), env: { FIGMA_TOKEN } },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/0 new/);
    expect(existsSync(join(out, "ds/button.png"))).toBe(true);
  }, 30_000);
});

describe("judge parse", () => {
  test("mlx banners still yield OK vs VIOLATION; bare VIOLATION is mismatch", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      ["--live", pages.url("live.html"), "--local", pages.url("local.html"), "--ds", DS, "--out", out],
      cap.io,
      { spawn: parseSpawn() },
    );
    expect(code).toBe(1);
    const html = await Bun.file(join(out, "report.html")).text();
    const alreadyHtml = html.match(/<section class="already">[\s\S]*?<\/section>/)?.[0] ?? "";
    const newHtml = html.match(/<section class="new">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(alreadyHtml).toContain("<h3>button</h3>");
    expect(alreadyHtml).toContain("fill is red not blue");
    expect(alreadyHtml).not.toContain("<h3>heading</h3>");
    expect(alreadyHtml).not.toContain("<h3>card</h3>");
    expect(newHtml).toContain("<h3>card</h3>");
    expect(newHtml).toContain("mismatch");
    expect(newHtml).not.toContain("<h3>heading</h3>");
    expect(newHtml).not.toContain("<h3>button</h3>");
  }, 30_000);
});

describe("pixel run", () => {
  test("--live-png --local-png without --ds stores overlay + manifest", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      ["--live-png", join(DS, "button.png"), "--local-png", join(DS, "card.png"), "--out", out, "--label", "omnishell"],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/changed pixels/);
    expect(cap.stdout).not.toMatch(/skip: no judge/);
    expect(existsSync(join(out, "main.png"))).toBe(true);
    expect(existsSync(join(out, "branch.png"))).toBe(true);
    expect(existsSync(join(out, "diff.png"))).toBe(true);
    const manifest = JSON.parse(await Bun.file(join(out, "manifest.json")).text()) as {
      changedPixels: number;
      createdAt: string;
      label?: string;
    };
    expect(manifest.changedPixels).toBeGreaterThan(0);
    expect(manifest.createdAt).toMatch(/^\d{4}-/);
    expect(manifest.label).toBe("omnishell");
  });

  test("identical pngs → changedPixels 0, still stores the run", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      ["--live-png", join(DS, "button.png"), "--local-png", join(DS, "button.png"), "--out", out],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/0 changed pixels/);
    const manifest = JSON.parse(await Bun.file(join(out, "manifest.json")).text()) as { changedPixels: number };
    expect(manifest.changedPixels).toBe(0);
    expect(existsSync(join(out, "diff.png"))).toBe(true);
  });

  test("--push POSTs multipart with bearer and prints dashboard url", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const posts: { url: string; auth: string | null; files: string[] }[] = [];
    const fetch = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const form = init?.body as FormData;
      posts.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
        files: ["main", "branch", "diff", "manifest"].filter((k) => form.get(k) != null),
      });
      return Response.json({ id: "run1" }, { status: 200 });
    };
    const code = await run(
      ["--live-png", join(DS, "button.png"), "--local-png", join(DS, "card.png"), "--out", out, "--push"],
      cap.io,
      {
        which: () => null,
        fetch,
        env: { OMNIBUS_API: "http://192.168.0.30:5050", OMNIBUS_API_TOKEN: "tok" },
      },
    );
    expect(code).toBe(0);
    expect(posts).toEqual([
      {
        url: "http://192.168.0.30:5050/api/pixelslash/runs",
        auth: "Bearer tok",
        files: ["main", "branch", "diff", "manifest"],
      },
    ]);
    expect(cap.stdout).toContain("http://192.168.0.30:5050/pixelslash/run1");
  });
});

function fakeCapture(shots: { url: string; width: number }[]): CapturePage {
  return async (url, dest, width) => {
    shots.push({ url, width });
    const src = url.includes("branch") ? join(DS, "card.png") : join(DS, "button.png");
    await Bun.write(dest, Bun.file(src));
  };
}

describe("url pair without a design system", () => {
  test("--live --local with neither --ds nor --file stores overlay + manifest and exits 0", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const shots: { url: string; width: number }[] = [];
    let spawned = false;
    const code = await run(
      ["--live", "http://main.example/", "--local", "http://branch.example/", "--out", out],
      cap.io,
      {
        capture: fakeCapture(shots),
        which: () => null,
        spawn: () => {
          spawned = true;
          return fakeProc("OK");
        },
      },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(shots).toEqual([
      { url: "http://main.example/", width: 1280 },
      { url: "http://branch.example/", width: 1280 },
    ]);
    expect(cap.stdout).toMatch(/changed pixels/);
    expect(cap.stdout).not.toMatch(/skip: no judge/);
    expect(existsSync(join(out, "main.png"))).toBe(true);
    expect(existsSync(join(out, "branch.png"))).toBe(true);
    expect(existsSync(join(out, "diff.png"))).toBe(true);
    const manifest = JSON.parse(await Bun.file(join(out, "manifest.json")).text()) as {
      changedPixels: number;
      createdAt: string;
    };
    expect(manifest.changedPixels).toBeGreaterThan(0);
    expect(manifest.createdAt).toMatch(/^\d{4}-/);
  });

  test("--push of a URL pair prints the dashboard url", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const posts: { url: string; auth: string | null; files: string[] }[] = [];
    const fetch = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const form = init?.body as FormData;
      posts.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
        files: ["main", "branch", "diff", "manifest"].filter((k) => form.get(k) != null),
      });
      return Response.json({ id: "run1" }, { status: 200 });
    };
    const code = await run(
      ["--live", "http://main.example/", "--local", "http://branch.example/", "--out", out, "--push"],
      cap.io,
      {
        capture: fakeCapture([]),
        fetch,
        env: { OMNIBUS_API: "http://192.168.0.30:5050", OMNIBUS_API_TOKEN: "tok" },
      },
    );
    expect(code).toBe(0);
    expect(posts).toEqual([
      {
        url: "http://192.168.0.30:5050/api/pixelslash/runs",
        auth: "Bearer tok",
        files: ["main", "branch", "diff", "manifest"],
      },
    ]);
    expect(cap.stdout).toContain("http://192.168.0.30:5050/pixelslash/run1");
  });

  test("--routes with URL origins pixel-diffs each path without a design system", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const routes = join(dir, "routes.txt");
    await Bun.write(routes, "/\n\n/pricing/\n");
    const cap = capture();
    const shots: { url: string; width: number }[] = [];
    let spawned = false;
    let fetched = false;
    const code = await run(
      [
        "--live",
        "http://main.example",
        "--local",
        "http://branch.example",
        "--routes",
        routes,
        "--out",
        out,
        "--width",
        "800",
      ],
      cap.io,
      {
        capture: fakeCapture(shots),
        which: () => null,
        spawn: () => {
          spawned = true;
          return fakeProc("VIOLATION nope");
        },
        fetch: async () => {
          fetched = true;
          throw new Error("figma must not be called");
        },
      },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(fetched).toBe(false);
    expect(shots).toEqual([
      { url: "http://main.example/", width: 800 },
      { url: "http://branch.example/", width: 800 },
      { url: "http://main.example/pricing", width: 800 },
      { url: "http://branch.example/pricing", width: 800 },
    ]);
    for (const slug of ["index", "pricing"]) {
      const routeOut = join(out, slug);
      expect(existsSync(join(routeOut, "live.png"))).toBe(true);
      expect(existsSync(join(routeOut, "local.png"))).toBe(true);
      expect(existsSync(join(routeOut, "diff.png"))).toBe(true);
      const manifest = JSON.parse(await Bun.file(join(routeOut, "manifest.json")).text()) as {
        changedPixels: number;
      };
      expect(manifest.changedPixels).toBeGreaterThan(0);
      const report = await Bun.file(join(routeOut, "report.html")).text();
      expect(report).toContain(slug === "index" ? "/" : "/pricing");
      expect(report).toContain("changed pixels");
      expect(report).toContain("main.png");
      expect(report).toContain("branch.png");
      expect(report).toContain("diff.png");
    }
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain('href="index/report.html"');
    expect(index).toContain('href="pricing/report.html"');
    expect(index).toContain("/pricing");
    expect(cap.stdout).toMatch(/\d+ changed pixels/);
    expect(cap.stdout).toContain("file://");
    expect(cap.stdout).toContain("index.html");
    expect(cap.stdout).not.toMatch(/skip: no judge/);
    expect(cap.stdout).not.toMatch(/new on branch/);
  });

  test("--push with --routes stays a single pair", async () => {
    const dir = await tmp();
    const routes = join(dir, "routes.txt");
    await Bun.write(routes, "/\n");
    const cap = capture();
    const shots: { url: string; width: number }[] = [];
    const code = await run(
      ["--live", "http://main.example/", "--local", "http://branch.example/", "--routes", routes, "--push"],
      cap.io,
      { capture: fakeCapture(shots) },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--push is for a single pair/);
    expect(shots).toEqual([]);
  });
});
