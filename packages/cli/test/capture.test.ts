import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
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
