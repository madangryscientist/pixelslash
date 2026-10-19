import { afterAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
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
});

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
