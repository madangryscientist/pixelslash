import { afterAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DiffOptions, IgnoreRect } from "@pixelslash/engine";
import { run } from "../src/run.ts";
import { capture, cleanup, solidPng, tmp } from "./support.ts";

afterAll(cleanup);

type Shot = {
  name: string;
  theme?: "light" | "dark";
  grey: number;
  diff?: DiffOptions;
  ignore?: IgnoreRect[];
  fonts?: string;
};

/** A snapshot dir as `pixelslash capture` writes it: solid 40x40 shots and a manifest. */
async function snapshotDir(shots: Shot[]): Promise<string> {
  const dir = await tmp();
  const snapshots = [];
  for (const s of shots) {
    const theme = s.theme ?? "light";
    const file = `${s.name}/${theme}.png`;
    await Bun.write(join(dir, file), solidPng(40, 40, [s.grey, s.grey, s.grey, 255]));
    snapshots.push({
      name: s.name,
      path: `/${s.name}`,
      variant: { name: theme, browser: "chromium", viewport: { width: 40, height: 40 }, theme },
      tags: [],
      diff: s.diff ?? {},
      ignore: s.ignore ?? [],
      file,
      fingerprint: { image: "version:t", browser: "chromium 1", fonts: s.fonts ?? "sha256:a" },
    });
  }
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots }));
  return dir;
}

const BOX = { x: 0, y: 0, width: 40, height: 40 };

async function pair(mainFonts?: string) {
  const main = await snapshotDir([
    { name: "home", grey: 100 },
    { name: "about", grey: 100, ...(mainFonts && { fonts: mainFonts }) },
    { name: "legacy", grey: 100 },
    { name: "masked", grey: 100 },
    { name: "moved", grey: 100, ignore: [BOX] },
    { name: "tolerant", grey: 100, diff: { threshold: 0 } },
    { name: "strict", grey: 100 },
  ]);
  const branch = await snapshotDir([
    { name: "home", grey: 220 },
    { name: "about", grey: 100 },
    { name: "fresh", grey: 100 },
    { name: "home", theme: "dark", grey: 100 },
    { name: "masked", grey: 220, ignore: [BOX] },
    { name: "moved", grey: 220 },
    { name: "tolerant", grey: 110, diff: { threshold: 0.5 } },
    { name: "strict", grey: 110 },
  ]);
  return { main, branch };
}

describe("compare", () => {
  test("changed, unchanged, new, removed, ignore, per-snapshot threshold", async () => {
    const { main, branch } = await pair();
    const out = await tmp();
    const cap = capture();
    const code = await run(["compare", main, branch, "--out", out], cap.io, {});
    expect(code).toBe(0);
    expect(cap.stdout).toContain("pixelslash: 2 changed, 4 unchanged, 2 new, 1 removed");
    expect(cap.stdout).toContain(`report: file://${join(out, "index.html")}`);
    expect(cap.stderr).toMatch(/^timing: 6 shots, diff \d+\.\ds, total \d+\.\ds\n$/);

    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain("2 changed · 4 unchanged · 2 new · 1 removed");
    expect(index).not.toContain('class="warn"');
    // Linked: the two changed snapshots, and only them.
    expect(index).toContain('href="home/chromium-40x40-light/report.html"');
    expect(index).toContain('href="strict/chromium-40x40-light/report.html"');
    expect(index.match(/report\.html/g)).toHaveLength(2);

    const report = await Bun.file(join(out, "home/chromium-40x40-light/report.html")).text();
    expect(report).toContain("home · chromium 40x40 prefers: light");
    expect(report).toContain("1600 changed pixels");
    for (const f of ["main.png", "branch.png", "diff.png"])
      expect(existsSync(join(out, "home/chromium-40x40-light", f))).toBe(true);
    // The branch's threshold decides: the same faint step is changed for `strict`, not `tolerant`.
    expect(existsSync(join(out, "tolerant"))).toBe(false);
    expect(existsSync(join(out, "masked"))).toBe(false);
  });

  test("names the changed, new and removed snapshots under the counts line", async () => {
    const main = await snapshotDir([
      { name: "a", grey: 100 },
      { name: "b", grey: 100 },
      { name: "c", grey: 100 },
      { name: "same", grey: 100 },
      { name: "gone", grey: 100 },
    ]);
    const branch = await snapshotDir([
      { name: "a", grey: 220 },
      { name: "b", grey: 220 },
      { name: "c", theme: "light", grey: 220 },
      { name: "same", grey: 100 },
      { name: "fresh", theme: "dark", grey: 100 },
    ]);
    const out = await tmp();
    const cap = capture();
    expect(await run(["compare", main, branch, "--out", out], cap.io, {})).toBe(0);
    const lines = cap.stdout.split("\n");
    expect(lines.slice(0, 9)).toEqual([
      "pixelslash: 3 changed, 1 unchanged, 1 new, 1 removed",
      "changed:",
      "  a (chromium 40x40 prefers: light)",
      "  b (chromium 40x40 prefers: light)",
      "  c (chromium 40x40 prefers: light)",
      "new:",
      "  fresh (chromium 40x40 prefers: dark)",
      "removed:",
      "  gone (chromium 40x40 prefers: light)",
    ]);
    expect(cap.stdout).not.toContain("same");

    // The index leads with the same names, each linking to its entry further down the page.
    const index = await Bun.file(join(out, "index.html")).text();
    const top = index.slice(0, index.indexOf("<section>"));
    expect(top).toContain("<h3>Changed</h3>");
    expect(top).toContain("<h3>New</h3>");
    expect(top).toContain("<h3>Removed</h3>");
    expect(top).not.toContain("same");
    const hrefs = [...top.matchAll(/<a href="#([^"]+)">/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(5);
    for (const id of hrefs) expect(index.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
  });

  test("caps each group at 10 names and says how many more", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    const main = await snapshotDir(names.map((name) => ({ name, grey: 100 })));
    const branch = await snapshotDir(names.map((name) => ({ name, grey: 220 })));
    const out = await tmp();
    const cap = capture();
    await run(["compare", main, branch, "--out", out], cap.io, {});
    const lines = cap.stdout.split("\n");
    expect(lines[0]).toBe("pixelslash: 12 changed, 0 unchanged, 0 new, 0 removed");
    expect(lines[1]).toBe("changed:");
    expect(lines.slice(2, 12)).toEqual(names.slice(0, 10).map((n) => `  ${n} (chromium 40x40)`));
    expect(lines[12]).toBe("  +2 more");
    expect(cap.stdout).not.toContain("s10");
    // The report is not capped.
    const index = await Bun.file(join(out, "index.html")).text();
    const top = index.slice(0, index.indexOf("<section>"));
    expect(top.match(/<a href="#/g)).toHaveLength(12);
  });

  test("two names that slug alike still get their own anchors", async () => {
    const main = await snapshotDir([
      { name: "a b", grey: 100 },
      { name: "a-b", grey: 100 },
    ]);
    const branch = await snapshotDir([
      { name: "a b", grey: 220 },
      { name: "a-b", grey: 220 },
    ]);
    const out = await tmp();
    await run(["compare", main, branch, "--out", out], capture().io, {});
    const index = await Bun.file(join(out, "index.html")).text();
    const ids = [...index.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test("with nothing changed, the counts line is all there is", async () => {
    const main = await snapshotDir([{ name: "home", grey: 100 }]);
    const branch = await snapshotDir([{ name: "home", grey: 100 }]);
    const out = await tmp();
    const cap = capture();
    await run(["compare", main, branch, "--out", out], cap.io, {});
    expect(cap.stdout).toBe(
      `pixelslash: 0 changed, 1 unchanged, 0 new, 0 removed\nreport: file://${join(out, "index.html")}\n`,
    );
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).not.toContain('class="names"');
  });

  test("an ignore box on either side skips the change, like the server's union", async () => {
    const { main, branch } = await pair();
    const out = await tmp();
    const cap = capture();
    await run(["compare", main, branch, "--out", out], cap.io, {});
    const index = await Bun.file(join(out, "index.html")).text();
    const section = (title: string) =>
      index.slice(index.indexOf(`<h2>${title}`)).split("</section>")[0] ?? "";
    // `masked` has the box on Branch only, `moved` on Main only: both are unchanged.
    expect(section("Unchanged")).toContain("masked");
    expect(section("Unchanged")).toContain("moved");
    expect(section("Changed")).not.toMatch(/masked|moved/);
  });

  test("a snapshot named index.html does not collide with the index", async () => {
    const main = await snapshotDir([{ name: "index.html", grey: 100 }]);
    const branch = await snapshotDir([{ name: "index.html", grey: 220 }]);
    const out = await tmp();
    const cap = capture();
    expect(await run(["compare", main, branch, "--out", out], cap.io, {})).toBe(0);
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain('href="-index.html/chromium-40x40-light/report.html"');
    expect(existsSync(join(out, "-index.html/chromium-40x40-light/report.html"))).toBe(true);
  });

  test("different fingerprints: warned by name, still diffed, stated at the top of the index", async () => {
    const { main, branch } = await pair("sha256:other");
    const out = await tmp();
    const cap = capture();
    const code = await run(["compare", main, branch, "--out", out], cap.io, {});
    expect(code).toBe(0);
    expect(cap.stderr).toContain(
      "warning: about (chromium 40x40 prefers: light): rendered by a different fonts",
    );
    expect(cap.stdout).toContain("fingerprint: 1 differ (diffed anyway)");
    expect(cap.stdout).toContain("2 changed, 4 unchanged");
    const index = await Bun.file(join(out, "index.html")).text();
    expect(index.indexOf('class="warn"')).toBeGreaterThan(0);
    expect(index.indexOf('class="warn"')).toBeLessThan(index.indexOf("2 changed"));
    expect(index).toContain("about (fonts)");
  });

  test("a bad dir, a bad manifest, a missing argument or an --out inside a snapshot dir exit 2", async () => {
    const { main, branch } = await pair();
    const empty = await tmp();
    const broken = await tmp();
    await Bun.write(join(broken, "manifest.json"), "{");
    const out = await tmp();
    const cases: string[][] = [
      ["compare", main, join(empty, "nope")],
      ["compare", main, empty],
      ["compare", broken, branch],
      ["compare", main],
      ["compare", main, branch, "--out", join(branch, "reports")],
    ];
    for (const argv of cases) {
      const cap = capture();
      expect(
        await run([...argv, ...(argv.includes("--out") ? [] : ["--out", out])], cap.io, {}),
      ).toBe(2);
      expect(cap.stderr).toContain("pixelslash compare MAIN_DIR BRANCH_DIR");
    }
  });
});
