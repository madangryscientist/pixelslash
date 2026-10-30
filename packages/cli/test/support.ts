import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { CapturePage, ProcLike, RunManifest, SpawnProc } from "@hackcove/pixelslash-engine";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));
export const PAGES = join(FIXTURES, "pages");
export const DS = join(FIXTURES, "ds");
const temps: string[] = [];
const servers: Array<{ stop(): Promise<void> }> = [];

/** Stop every test server and remove every temp dir. Each test file passes this to `afterAll`. */
export async function cleanup(): Promise<void> {
  await Promise.all(servers.map((s) => s.stop()));
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

export async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visual-compare-"));
  temps.push(dir);
  return dir;
}

export function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(s: string) {
          stdout += s;
        },
      },
      stderr: {
        write(s: string) {
          stderr += s;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

const enc = new TextEncoder();

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      if (text) c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

export function fakeProc(
  stdoutText: string,
  stderrText = "",
  exitCode: number | null = 0,
): ProcLike {
  return {
    stdout: stream(stdoutText),
    stderr: stream(stderrText),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode: null,
  };
}

export function imagesAfterFlag(cmd: string[]): string[] {
  const i = cmd.indexOf("--image");
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < cmd.length; j++) {
    if (cmd[j]!.startsWith("-")) break;
    out.push(cmd[j]!);
  }
  return out;
}

export function componentOf(cmd: string[]): string {
  const images = imagesAfterFlag(cmd);
  return basename(images[1] ?? "").replace(/\.png$/i, "");
}

export function pageOf(cmd: string[]): "live" | "local" | "other" {
  const page = imagesAfterFlag(cmd)[0] ?? "";
  if (page.includes("live")) return "live";
  if (page.includes("local")) return "local";
  return "other";
}

export function newMissSpawn(): SpawnProc {
  return (cmd) => {
    const component = componentOf(cmd);
    const page = pageOf(cmd);
    if (component === "button") return fakeProc("VIOLATION fill is red not blue");
    if (component === "card" && page === "local") return fakeProc("VIOLATION card has no border");
    return fakeProc("OK");
  };
}

export function identicalSpawn(): SpawnProc {
  return (cmd) => {
    const component = componentOf(cmd);
    if (component === "button") return fakeProc("VIOLATION fill is red not blue");
    return fakeProc("OK");
  };
}

export async function servePages(): Promise<{ url(file: string): string }> {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, "");
      if (name === "late.png") {
        // Delayed on purpose: proves the capture settle waits for a late image.
        await Bun.sleep(150);
        return new Response(solidPng(40, 20, [34, 197, 94, 255]), {
          headers: { "content-type": "image/png" },
        });
      }
      const file = Bun.file(join(PAGES, name));
      if (await file.exists())
        return new Response(file, { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { url: (file: string) => `http://127.0.0.1:${server.port}/${file}` };
}

/** Serve one fixture page per path (`{ "/": "live.html" }`); any other path is 404. Returns the origin. */
export function servePaths(files: Record<string, string>): string {
  const byPath = new Map(Object.entries(files));
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const file = byPath.get(new URL(req.url).pathname);
      if (!file) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(PAGES, file)), {
        headers: { "content-type": "text/html" },
      });
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

export function pngWidth(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(16);
}

export function mlxStdout(answer: string): string {
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

export function parseSpawn(): SpawnProc {
  return (cmd) => {
    const component = componentOf(cmd);
    const page = pageOf(cmd);
    if (component === "button") return fakeProc(mlxStdout("VIOLATION fill is red not blue"));
    if (component === "card" && page === "local") return fakeProc(mlxStdout("VIOLATION"));
    return fakeProc(mlxStdout("OK"));
  };
}

export const FILE_KEY = "ExampleFigmaFileKey000";
export const FIGMA_TOKEN = "test-figma-token";

export function figmaFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin === "https://api.figma.com") {
      const token = new Headers(init?.headers).get("X-Figma-Token");
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
    if (url === "https://files.example/button.png")
      return new Response(Bun.file(join(DS, "button.png")));
    if (url === "https://files.example/card.png")
      return new Response(Bun.file(join(DS, "card.png")));
    if (url === "https://files.example/heading.png")
      return new Response(Bun.file(join(DS, "heading.png")));
    throw new Error(`unexpected fetch: ${url}`);
  };
}

export function solidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const o = i << 2;
    img.data[o] = rgba[0];
    img.data[o + 1] = rgba[1];
    img.data[o + 2] = rgba[2];
    img.data[o + 3] = rgba[3];
  }
  return PNG.sync.write(img);
}

export function fakeCapture(shots: { url: string; width: number }[]): CapturePage {
  return async (url, dest, width) => {
    shots.push({ url, width });
    const src = url.includes("branch") ? join(DS, "card.png") : join(DS, "button.png");
    await Bun.write(dest, Bun.file(src));
  };
}

function isManifest(value: unknown): value is RunManifest {
  if (!value || typeof value !== "object") return false;
  const m: Partial<Record<keyof RunManifest, unknown>> = value;
  const labelOk = m.label === undefined || typeof m.label === "string";
  return (
    typeof m.id === "string" &&
    typeof m.changedPixels === "number" &&
    typeof m.createdAt === "string" &&
    labelOk
  );
}

export async function readManifest(path: string): Promise<RunManifest> {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  if (!isManifest(value)) throw new Error(`not a run manifest: ${path}`);
  return value;
}

/** Two solid shots one grey step apart: a faint change the default threshold flags. */
export async function faintPair(dir: string) {
  const [live, local] = [join(dir, "live.png"), join(dir, "local.png")];
  await Bun.write(live, solidPng(20, 20, [100, 100, 100, 255]));
  await Bun.write(local, solidPng(20, 20, [110, 110, 110, 255]));
  return { live, local };
}
