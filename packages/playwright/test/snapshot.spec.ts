import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { keepNativeRaf, snapshot } from "../src/index.ts";
import { portOf, type ShotMeta, uploadStub } from "./upload-stub.ts";

const CLI = join(import.meta.dirname, "../../cli/src/index.ts");
const exec = promisify(execFile);

/** This spec runs under Node, as a user's suite does; only the CLI it uploads with runs on Bun. */
type Manifest = { snapshots: { name: string }[] };

async function readManifest(dir: string): Promise<Manifest> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("snapshots" in parsed))
    throw new Error(`${dir}/manifest.json has no snapshots`);
  const { snapshots } = parsed;
  if (!Array.isArray(snapshots)) throw new Error(`${dir}/manifest.json: snapshots is not a list`);
  return { snapshots };
}

/** Two PNGs' decoded pixels differ (the bytes alone could differ by compression). */
async function pixelsDiffer(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (f) => PNG.sync.read(await readFile(f))));
  return x!.width !== y!.width || x!.height !== y!.height || !x!.data.equals(y!.data);
}

/** The page globals the callbacks touch (the tsconfig has no DOM lib). Type-only. */
declare const window: { scrollY: number; scrollTo(x: number, y: number): void };

/** A page with a "video": a canvas painting fresh noise every frame at (40, 1000), below the fold. */
const FIXTURE = `<!doctype html>
<html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  body { height: 1400px; }
  .secret { position: absolute; left: 20px; top: 60px; width: 200px; height: 30px; margin: 0; }
  .player { position: absolute; left: 40px; top: 1000px; }
</style></head><body>
  <h1>Fixture</h1>
  <p class="secret">psci_not_for_upload</p>
  <canvas class="player" width="160" height="90"></canvas>
  <script>
    const c = document.querySelector("canvas").getContext("2d");
    (function draw() {
      for (let i = 0; i < 40; i++) {
        c.fillStyle = "hsl(" + Math.random() * 360 + " 80% 50%)";
        c.fillRect(Math.random() * 160, Math.random() * 90, 20, 20);
      }
      requestAnimationFrame(draw);
    })();
  </script>
</body></html>`;

let site: Server;
let siteUrl: string;
let work: string;

test.beforeAll(async () => {
  site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(FIXTURE);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  siteUrl = `http://127.0.0.1:${portOf(site)}/`;
  work = await mkdtemp(join(tmpdir(), "ps-playwright-"));
});

test.afterAll(async () => {
  site.closeAllConnections();
  await new Promise((done) => site.close(done));
  await rm(work, { recursive: true, force: true });
});

async function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  try {
    return (await exec(cmd, args, { cwd, env: { ...process.env, ...env } })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${String(e)}`, { cause: e });
  }
}

/** Upload each dir in turn, from a git repo on `main`, to a stub; the shots' metas, in order. */
async function uploadEach(dirs: string[]): Promise<ShotMeta[]> {
  const repo = join(work, "repo");
  await run("git", ["init", "-q", "-b", "main", repo], work);
  const author = ["-c", "user.name=t", "-c", "user.email=t@t"];
  await run("git", [...author, "commit", "-q", "--allow-empty", "-m", "m0"], repo);
  const stub = uploadStub();
  const url = await stub.ready();
  try {
    const env = { PIXELSLASH_TOKEN: "psci_test", HOME: work };
    for (const dir of dirs) {
      const flags = ["--server", url, "--branch", "e2e", "--flake-retries", "0"];
      await run("bun", [CLI, "upload", dir, ...flags], repo, env);
    }
  } finally {
    await stub.stop();
  }
  return stub.metas;
}

test.describe("a device scale factor of 2", () => {
  test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2 });

  test("an ignored video, shot twice and uploaded twice, diffs unchanged with ignored pixels", async ({
    page,
  }) => {
    const dirs = [join(work, "run1"), join(work, "run2")];

    for (const dir of dirs) {
      await page.goto(`${siteUrl}watch`);
      await page.evaluate(() => window.scrollTo(0, 400));
      const entry = await snapshot(page, "watch", { ignore: [".player"], dir, tags: ["video"] });
      // Scrolled 400px down, the box is still measured from the top of the document, at 2x.
      expect(await page.evaluate(() => window.scrollY)).toBe(400);
      expect(entry.ignore).toEqual([{ x: 80, y: 2000, width: 320, height: 180 }]);
      expect(entry.variant).toEqual({
        name: "640x480-light",
        browser: "chromium",
        viewport: { width: 640, height: 480 },
        theme: "light",
      });
      const manifest = await readManifest(dir);
      expect(manifest.snapshots).toEqual([entry]);
    }

    // The video really changed between the runs: without the ignore box the diff says so.
    const [first, second] = dirs.map((d) => join(d, "watch/640x480-light.png"));
    expect(await pixelsDiffer(first!, second!)).toBe(true);

    const [baseline, rerun] = await uploadEach(dirs);
    expect(baseline?.ci).toBeUndefined();
    expect(rerun!.ignore).toHaveLength(1);
    const results = rerun!.ci!.results;
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("unchanged");
    expect(results[0]!.diffResult.ignoredPixels).toBeGreaterThan(0);
  });
});

test("a viewport shot measures from the viewport, and redact paints the element over", async ({
  page,
}) => {
  const dir = join(work, "viewport");
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`${siteUrl}watch`);
  await page.evaluate(() => window.scrollTo(0, 300));
  const entry = await snapshot(page, "watch", {
    ignore: [".player"],
    redact: [".secret"],
    fullPage: false,
    variant: "tall",
    dir,
  });
  expect(entry.ignore).toEqual([{ x: 40, y: 700, width: 160, height: 90 }]);
  expect(entry.file).toBe("watch/tall.png");
  // The secret is at (20, 60) on the page, so (20, -240) in this shot: scroll back and shoot it.
  await page.evaluate(() => window.scrollTo(0, 0));
  const top = await snapshot(page, "top", { redact: [".secret"], fullPage: false, dir });
  const img = PNG.sync.read(await readFile(join(dir, top.file)));
  const at = (65 * img.width + 25) << 2;
  expect([...img.data.subarray(at, at + 4)]).toEqual([255, 0, 255, 255]);
});

test("shots from parallel calls all land in one manifest", async ({ browser }) => {
  const dir = join(work, "parallel");
  const names = ["a", "b", "c", "d"];
  await Promise.all(
    names.map(async (name) => {
      const page = await browser.newPage();
      await page.goto(`${siteUrl}${name}`);
      await snapshot(page, name, { dir, ignore: [".player"] });
      await page.close();
    }),
  );
  const manifest = await readManifest(dir);
  expect(manifest.snapshots.map((e) => e.name)).toEqual(names);
});

test("a name that climbs out of the dir is refused", async ({ page }) => {
  await page.goto(siteUrl);
  await expect(snapshot(page, "../out", { dir: join(work, "bad") })).rejects.toThrow(/outside/);
});

test("a second variant of the same shot is refused, not silently replaced", async ({ page }) => {
  const dir = join(work, "clash");
  await page.goto(siteUrl);
  await snapshot(page, "home", { variant: "signed-in", dir });
  await expect(snapshot(page, "home", { variant: "signed-out", dir })).rejects.toThrow(/same shot/);
  await snapshot(page, "home", { variant: "signed-in", dir });
});

test("with a pinned clock the video stops and the settle still ends", async ({ page }) => {
  const time = new Date("2026-01-01T00:00:00Z");
  await page.addInitScript(keepNativeRaf);
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto(`${siteUrl}watch`);
  const dirs = [join(work, "pinned1"), join(work, "pinned2")];
  for (const dir of dirs) await snapshot(page, "watch", { dir });
  const [first, second] = dirs.map((d) => join(d, "watch/1280x720-light.png"));
  expect(await pixelsDiffer(first!, second!)).toBe(false);
});

/** The stderr lines a worker process prints as it exits, for the ones that name `selector` (PS-241). */
async function tallyLines(selector: string, bodies: string[], dir: string): Promise<string[]> {
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "unmatched-child.mjs"), selector, ...bodies],
    { env: { ...process.env, PIXELSLASH_SNAPSHOT_DIR: dir }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const code = await new Promise((done) => child.on("close", done));
  expect(code).toBe(0);
  return err.split("\n").filter((line) => line.includes(selector));
}

test("a selector that matches some shots is one summary line at exit, not a line per shot", async () => {
  const lines = await tallyLines(
    ".video",
    ['<div class="video">a</div>', "<p>plain</p>", "<p>plain</p>"],
    join(work, "some"),
  );
  expect(lines).toEqual(['ignore ".video" matched nothing on 2 of 3 shots']);
});

test("a selector that matches no shot is one warning at exit, naming it as matching no shot", async () => {
  const lines = await tallyLines(".vdeo", ["<p>a</p>", "<p>b</p>"], join(work, "none"));
  expect(lines).toEqual(['warning: ignore ".vdeo" matched no shot in this run']);
});

/** What `boxes.mjs` prints for the fixture under `runtime`, with the shots in a fresh dir. */
async function boxes(runtime: string, dir: string): Promise<unknown> {
  const out = await run(
    runtime,
    [join(import.meta.dirname, "boxes.mjs"), `${siteUrl}watch`],
    work,
    {
      PIXELSLASH_SNAPSHOT_DIR: dir,
    },
  );
  return JSON.parse(out);
}

test("the ignore and redact boxes are the same under Node and Bun", async () => {
  const underNode = await boxes("node", join(work, "boxes-node"));
  const underBun = await boxes("bun", join(work, "boxes-bun"));
  expect(underNode).toMatchObject({
    ignore: [{ x: 80, y: 2000, width: 320, height: 180 }],
    redacted: [255, 0, 255, 255],
  });
  expect(underBun).toEqual(underNode);
});
