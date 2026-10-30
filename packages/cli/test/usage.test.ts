import { afterAll, describe, expect, test } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run.ts";
import {
  DS,
  FIGMA_TOKEN,
  FILE_KEY,
  capture,
  cleanup,
  figmaFetch,
  identicalSpawn,
  newMissSpawn,
  servePages,
  tmp,
} from "./support.ts";

afterAll(cleanup);

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
      [
        "--live",
        "http://127.0.0.1:1/",
        "--local",
        "http://127.0.0.1:1/",
        "--ds",
        join(tmpdir(), "visual-compare-no-ds"),
      ],
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
      [
        "--live",
        "http://127.0.0.1:1/",
        "--local",
        "http://127.0.0.1:1/",
        "--ds",
        DS,
        "--width",
        "0",
      ],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--width/);
  });

  test("--browser must be one the image ships", async () => {
    const cap = capture();
    const code = await run(
      ["--live", "http://127.0.0.1:1/", "--local", "http://127.0.0.1:1/", "--browser", "edge"],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--browser.*chromium, firefox, webkit/);
  });

  test("--browser applies to --live / --local, not PNG inputs", async () => {
    const cap = capture();
    const code = await run(
      ["--live-png", "a.png", "--local-png", "b.png", "--browser", "firefox"],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--browser applies to --live \/ --local/);
  });
});

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pixelslash-ds-"));
const judgeBoom = () => {
  throw new Error("judge exploded");
};

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

  describe("temp raster dir", () => {
    test("a passing run leaves no pixelslash-ds-* behind", async () => {
      const pages = await servePages();
      const dir = await tmp();
      const live = pages.url("live.html");
      const code = await run(
        ["--live", live, "--local", live, "--file", FILE_KEY, "--out", join(dir, "out")],
        capture().io,
        { spawn: identicalSpawn(), fetch: figmaFetch(), env: { FIGMA_TOKEN } },
      );
      expect(code).toBe(0);
      expect(existsSync(join(dir, "out/ds/button.png"))).toBe(true);
      expect(leftovers()).toEqual([]);
    }, 30_000);

    test("a thrown judge error leaves none behind", async () => {
      const pages = await servePages();
      const dir = await tmp();
      const live = pages.url("live.html");
      const cap = capture();
      const code = await run(
        ["--live", live, "--local", live, "--file", FILE_KEY, "--out", join(dir, "out")],
        cap.io,
        { spawn: judgeBoom, fetch: figmaFetch(), env: { FIGMA_TOKEN } },
      );
      expect(code).toBe(7);
      expect(cap.stderr).toContain("pixelslash: FAILED compare:");
      expect(cap.stderr).toContain("judge exploded");
      expect(leftovers()).toEqual([]);
    }, 30_000);

    test("a capture error leaves none behind", async () => {
      const dir = await tmp();
      const cap = capture();
      const code = await run(
        [
          "--live",
          "http://127.0.0.1:1/",
          "--local",
          "http://127.0.0.1:1/",
          "--file",
          FILE_KEY,
          "--out",
          join(dir, "out"),
        ],
        cap.io,
        { spawn: identicalSpawn(), fetch: figmaFetch(), env: { FIGMA_TOKEN } },
      );
      expect(code).toBe(1);
      expect(leftovers()).toEqual([]);
    }, 30_000);

    test("a failed Figma fetch leaves none behind", async () => {
      const dir = await tmp();
      const cap = capture();
      const code = await run(
        ["--live-png", "x.png", "--local-png", "y.png", "--file", FILE_KEY, "--out", dir],
        cap.io,
        { fetch: async () => new Response("nope", { status: 500 }), env: { FIGMA_TOKEN } },
      );
      expect(code).toBe(1);
      expect(cap.stderr).toMatch(/figma file 500/);
      expect(leftovers()).toEqual([]);
    });
  });
});
