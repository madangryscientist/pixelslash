import { afterAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { run } from "../src/run.ts";
import {
  DS,
  capture,
  cleanup,
  fakeCapture,
  fakeProc,
  solidPng,
  tmp,
  readManifest,
} from "./support.ts";

afterAll(cleanup);

/** Two solid shots one grey step apart: a faint change the default threshold flags. */
async function faintPair(dir: string) {
  const [live, local] = [join(dir, "live.png"), join(dir, "local.png")];
  await Bun.write(live, solidPng(20, 20, [100, 100, 100, 255]));
  await Bun.write(local, solidPng(20, 20, [110, 110, 110, 255]));
  return { live, local };
}

describe("diff options", () => {
  test("--threshold 0.2 flips a faint change to unchanged, and the report says so", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const defaults = capture();
    await run(["--live-png", live, "--local-png", local, "--out", join(dir, "a")], defaults.io, {});
    expect(defaults.stdout).toContain("400 changed pixels");
    expect(await Bun.file(join(dir, "a/report.html")).text()).not.toContain("Diff options");

    const loose = capture();
    const code = await run(
      ["--live-png", live, "--local-png", local, "--out", join(dir, "b"), "--threshold", "0.2"],
      loose.io,
      {},
    );
    expect(code).toBe(0);
    expect(loose.stdout).toContain("0 changed pixels");
    expect(await Bun.file(join(dir, "b/report.html")).text()).toContain(
      "Diff options: threshold 0.2",
    );
    expect(await readManifest(join(dir, "b/manifest.json"))).toMatchObject({
      changedPixels: 0,
      diff: { threshold: 0.2 },
    });
  });

  test("a floor keeps the count but the report says the shot is not changed", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    await run(
      ["--live-png", live, "--local-png", local, "--out", dir, "--min-changed-pixels", "1000"],
      cap.io,
      {},
    );
    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("400 changed pixels");
    expect(html).toContain("Diff options: min changed pixels 1000");
    expect(html).toContain("Not changed: 400 changed pixels are under the floors above.");
  });

  test("an option equal to the engine default is not reported as a difference", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    await run(
      ["--live-png", live, "--local-png", local, "--out", dir, "--threshold", "0.01"],
      capture().io,
      {},
    );
    expect(await Bun.file(join(dir, "report.html")).text()).not.toContain("Diff options");
  });

  test.each([
    [["--threshold", "2"], /--threshold must be a number from 0 to 1/],
    [["--threshold", "abc"], /--threshold must be a number from 0 to 1/],
    [["--min-changed-pixels", "1.5"], /--min-changed-pixels must be a non-negative integer/],
    [["--min-changed-ratio", "-1"], /--min-changed-ratio must be a number from 0 to 1/],
  ])("%j exits 2", async (flags, message) => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, ...flags], cap.io, {});
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(message);
  });
});

describe("pixel run", () => {
  test("--live-png --local-png without --ds stores overlay + manifest", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--out",
        out,
        "--label",
        "widget",
      ],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/changed pixels/);
    expect(cap.stdout).not.toMatch(/skip: no judge/);
    expect(existsSync(join(out, "main.png"))).toBe(true);
    expect(existsSync(join(out, "branch.png"))).toBe(true);
    expect(existsSync(join(out, "diff.png"))).toBe(true);
    const manifest = await readManifest(join(out, "manifest.json"));
    expect(manifest.changedPixels).toBeGreaterThan(0);
    expect(manifest.changedPixels).toBeLessThanOrEqual(120 * 40);
    expect(manifest.createdAt).toMatch(/^\d{4}-/);
    expect(manifest.label).toBe("widget");
    expect(cap.stdout).toContain("report.html");
    expect(cap.stdout).not.toContain("manifest.json");
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("Main");
    expect(html).toContain("Branch");
    expect(html).toContain("Diff");
    expect(html).toContain(`${manifest.changedPixels} changed pixels`);
    expect(html).toContain("Main 120x40");
    expect(html).toContain("Branch 160x80");
    const overlay = PNG.sync.read(Buffer.from(await Bun.file(join(out, "diff.png")).arrayBuffer()));
    const gutter = (79 * overlay.width + 159) << 2;
    expect(overlay.data[gutter + 3]).toBe(0);
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
    const manifest = await readManifest(join(out, "manifest.json"));
    expect(manifest.changedPixels).toBe(0);
    expect(existsSync(join(out, "diff.png"))).toBe(true);
    expect(cap.stdout).toContain("report.html");
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("0 changed pixels");
    expect(html).toContain("Main 120x40");
    expect(html).toContain("Branch 120x40");
  });

  test("size mismatch states both sizes and does not count the gutter", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const live = join(dir, "live.png");
    const local = join(dir, "local.png");
    await Bun.write(live, solidPng(2, 2, [0, 0, 0, 255]));
    await Bun.write(local, solidPng(4, 3, [0, 0, 0, 255]));
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, "--out", out], cap.io, {
      which: () => null,
    });
    expect(code).toBe(0);
    const manifest = await readManifest(join(out, "manifest.json"));
    expect(manifest.changedPixels).toBe(0);
    expect(cap.stdout).toContain(`file://${join(out, "report.html")}`);
    expect(cap.stdout).not.toContain("manifest.json");
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("0 changed pixels");
    expect(html).toContain("Main 2x2");
    expect(html).toContain("Branch 4x3");
    expect(html).toContain('alt="Main"');
    expect(html).toContain('alt="Branch"');
    expect(html).toContain('alt="Diff"');
    const overlay = PNG.sync.read(Buffer.from(await Bun.file(join(out, "diff.png")).arrayBuffer()));
    expect(overlay.width).toBe(4);
    expect(overlay.height).toBe(3);
    const gutter = (2 * overlay.width + 3) << 2;
    expect(overlay.data[gutter + 3]).toBe(0);
  });
});

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
    const manifest = await readManifest(join(out, "manifest.json"));
    expect(manifest.changedPixels).toBeGreaterThan(0);
    expect(manifest.createdAt).toMatch(/^\d{4}-/);
    expect(cap.stdout).toContain("report.html");
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("Main");
    expect(html).toContain("Branch");
    expect(html).toContain("Diff");
    expect(html).toContain("Main 120x40");
    expect(html).toContain("Branch 160x80");
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
      const manifest = await readManifest(join(routeOut, "manifest.json"));
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
});
