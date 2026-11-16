import { afterAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { run } from "../src/run.ts";
import {
  DS,
  capture,
  cleanup,
  identicalSpawn,
  newMissSpawn,
  parseSpawn,
  pngWidth,
  servePages,
  tmp,
  readManifest,
} from "./support.ts";

afterAll(cleanup);

describe("fixture run", () => {
  test("live has 1 DS miss, local adds 1 new miss → exit 1, HTML names the new miss", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live",
        pages.url("live.html"),
        "--local",
        pages.url("local.html"),
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
    const code = await run(["--live", live, "--local", live, "--ds", DS, "--out", out], cap.io, {
      spawn: identicalSpawn(),
    });
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

describe("capture settle", () => {
  test("end-to-end: content that arrives after domcontentloaded is in the shot", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      ["--live", pages.url("late.html"), "--local", pages.url("late.html"), "--out", out],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    const live = PNG.sync.read(Buffer.from(await Bun.file(join(out, "live.png")).arrayBuffer()));
    const o = (3 * live.width + 3) << 2;
    expect([live.data[o], live.data[o + 1], live.data[o + 2]]).toEqual([34, 197, 94]);
  }, 30_000);

  test("two captures of the unchanged page are identical (changedPixels 0)", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const url = pages.url("late.html");
    const code = await run(["--live", url, "--local", url, "--out", out], cap.io, {
      which: () => null,
    });
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/0 changed pixels/);
    const manifest = await readManifest(join(out, "manifest.json"));
    expect(manifest.changedPixels).toBe(0);
  }, 30_000);
});

describe("judge parse", () => {
  test("mlx banners still yield OK vs VIOLATION; bare VIOLATION is mismatch", async () => {
    const pages = await servePages();
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live",
        pages.url("live.html"),
        "--local",
        pages.url("local.html"),
        "--ds",
        DS,
        "--out",
        out,
      ],
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
