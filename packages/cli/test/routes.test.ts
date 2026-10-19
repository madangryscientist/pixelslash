import { afterAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnProc } from "@pixelslash/engine";
import { run } from "../src/run.ts";
import {
  DS,
  capture,
  cleanup,
  componentOf,
  fakeProc,
  identicalSpawn,
  imagesAfterFlag,
  servePaths,
  tmp,
} from "./support.ts";

afterAll(cleanup);

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
    expect(index).toContain('href="index/report.html"');
    expect(index).toContain('href="pricing/report.html"');
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
    expect(index).toContain('href="index/report.html"');
    const html = await Bun.file(join(out, "index/report.html")).text();
    expect(html).toContain("No violations on Main.");
    expect(html).toContain("No new violations");
    expect(html).not.toContain("<h3>");
  });

  test("URL origins + routes capture each path, no nx", async () => {
    const liveOrigin = servePaths({ "/": "live.html", "/pricing": "live.html" });
    const localOrigin = servePaths({ "/": "local.html", "/pricing": "live.html" });
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
      ["--live", liveOrigin, "--local", localOrigin, "--routes", routes, "--ds", DS, "--out", out],
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
    expect(index).toContain('href="index/report.html"');
    expect(index).toContain('href="pricing/report.html"');
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
    const code = await run(["--live-png-dir", dir, "--local-png-dir", dir, "--ds", DS], cap.io, {
      spawn: identicalSpawn(),
    });
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--routes/);
  });
});
