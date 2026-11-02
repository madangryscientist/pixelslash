import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

/**
 * The smoke layer (PS-15): the BUILT CLI, `packages/cli/dist/index.js` (`nx build cli`), as a child
 * process, the way the npm package runs. Nothing is imported from `src/`: what is proved is that the
 * bundle starts, finds its `diff.wasm`, diffs, and writes a report. The network is localhost only:
 * the page pair is served from this process, and no upload, judge or error sink is configured.
 */
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PAGES = fileURLToPath(new URL("../../../fixtures/pages", import.meta.url));

let work = "";
let site: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`nx smoke cli\`, which builds it`);
  work = await mkdtemp(join(tmpdir(), "ps-smoke-cli-"));
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      return /^[a-z]+\.html$/.test(name)
        ? new Response(Bun.file(join(PAGES, name)))
        : new Response("", { status: 404 });
    },
  });
});

afterAll(async () => {
  await site.stop(true);
  rmSync(work, { recursive: true, force: true });
});

/** The CLI with a clean environment: no token, server or error sink can reach it from the shell. */
async function pixelslash(args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("PIXELSLASH_")),
  );
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...env, TMPDIR: work },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A 40×30 white PNG, with a 10×10 red square at (5,5) when `square` is set. */
function shot(path: string, square: boolean) {
  const png = new PNG({ width: 40, height: 30 });
  png.data.fill(255);
  const [from, to] = square ? [5, 15] : [0, 0];
  for (let y = from; y < to; y++)
    for (let x = from; x < to; x++) png.data.set([220, 30, 30, 255], (y * 40 + x) * 4);
  return Bun.write(path, PNG.sync.write(png));
}

async function manifest(out: string) {
  const parsed: { changed: boolean; changedPixels: number; regions: unknown[] } = await Bun.file(
    join(out, "manifest.json"),
  ).json();
  return parsed;
}

describe("the built CLI", () => {
  test("a PNG pair: counts the change, writes the overlay and a report that shows all three", async () => {
    const [live, local, out] = [join(work, "a.png"), join(work, "b.png"), join(work, "png-out")];
    await shot(live, false);
    await shot(local, true);

    const run = await pixelslash(["--live-png", live, "--local-png", local, "--out", out]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("pixelslash: 100 changed pixels");
    expect(run.stdout).toContain(`report: file://${join(out, "report.html")}`);
    expect(await manifest(out)).toMatchObject({ changed: true, changedPixels: 100 });
    for (const name of ["main.png", "branch.png", "diff.png", "manifest.json"])
      expect(existsSync(join(out, name))).toBe(true);
    const report = await Bun.file(join(out, "report.html")).text();
    for (const image of ["main.png", "branch.png", "diff.png"])
      expect(report).toContain(`src="${image}"`);
  });

  test("an identical PNG pair is unchanged and still writes a report", async () => {
    const [png, out] = [join(work, "same.png"), join(work, "same-out")];
    await shot(png, true);

    const run = await pixelslash(["--live-png", png, "--local-png", png, "--out", out]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("pixelslash: 0 changed pixels");
    expect(await manifest(out)).toMatchObject({ changed: false, changedPixels: 0 });
    expect(existsSync(join(out, "report.html"))).toBe(true);
  });

  test("a local static page pair: captured in a real browser, diffed, reported", async () => {
    const out = join(work, "pages-out");

    const run = await pixelslash([
      "--live",
      `http://127.0.0.1:${site.port}/live.html`,
      "--local",
      `http://127.0.0.1:${site.port}/local.html`,
      "--out",
      out,
    ]);

    expect(run.stderr).not.toMatch(/error/i);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/pixelslash: [1-9]\d* changed pixels/);
    const found = await manifest(out);
    expect(found.changed).toBe(true);
    expect(found.regions.length).toBeGreaterThan(0);
    for (const name of ["live.png", "local.png", "diff.png", "report.html"])
      expect(existsSync(join(out, name))).toBe(true);
  }, 60_000);

  test("a page that is down fails, and no report is written", async () => {
    const out = join(work, "down-out");
    // A port that was listening a moment ago and is not now.
    const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const url = `http://127.0.0.1:${gone.port}/`;
    await gone.stop(true);

    const run = await pixelslash(["--live", url, "--local", url, "--out", out]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`capture failed for ${url}`);
    expect(existsSync(join(out, "report.html"))).toBe(false);
  }, 60_000);
});
