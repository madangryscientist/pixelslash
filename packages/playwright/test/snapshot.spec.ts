import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readManifest } from "@pixelslash/engine";
import { diffPngs } from "@pixelslash/engine/diff";
import { PNG } from "pngjs";
import { keepNativeRaf, snapshot } from "../src/index.ts";
import { type ShotMeta, uploadStub } from "./upload-stub.ts";

const CLI = join(import.meta.dirname, "../../cli/src/index.ts");

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

let site: ReturnType<typeof Bun.serve>;
let work: string;

test.beforeAll(async () => {
  site = Bun.serve({
    port: 0,
    fetch: () => new Response(FIXTURE, { headers: { "content-type": "text/html" } }),
  });
  work = await mkdtemp(join(tmpdir(), "ps-playwright-"));
});

test.afterAll(async () => {
  await site.stop(true);
  await rm(work, { recursive: true, force: true });
});

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = [
    await new Response(proc.stdout).text(),
    await new Response(proc.stderr).text(),
  ];
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out}${err}`);
  return out;
}

/** Upload each dir in turn, from a git repo on `main`, to a stub; the shots' metas, in order. */
async function uploadEach(dirs: string[]): Promise<ShotMeta[]> {
  const repo = join(work, "repo");
  await run(["git", "init", "-q", "-b", "main", repo], work);
  const author = ["-c", "user.name=t", "-c", "user.email=t@t"];
  await run(["git", ...author, "commit", "-q", "--allow-empty", "-m", "m0"], repo);
  const stub = uploadStub();
  try {
    const env = { PIXELSLASH_TOKEN: "psci_test", HOME: work };
    for (const dir of dirs) {
      const flags = ["--server", stub.url, "--branch", "e2e", "--flake-retries", "0"];
      await run(["bun", CLI, "upload", dir, ...flags], repo, env);
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
      await page.goto(`${site.url.href}watch`);
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
    const [first, second] = await Promise.all(
      dirs.map(async (d) =>
        Buffer.from(await Bun.file(join(d, "watch/640x480-light.png")).arrayBuffer()),
      ),
    );
    expect(diffPngs(first!, second!).changed).toBe(true);

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
  await page.goto(`${site.url.href}watch`);
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
  const img = PNG.sync.read(Buffer.from(await Bun.file(join(dir, top.file)).arrayBuffer()));
  const at = (65 * img.width + 25) << 2;
  expect([...img.data.subarray(at, at + 4)]).toEqual([255, 0, 255, 255]);
  await readManifest(dir);
});

test("shots from parallel calls all land in one manifest", async ({ browser }) => {
  const dir = join(work, "parallel");
  const names = ["a", "b", "c", "d"];
  await Promise.all(
    names.map(async (name) => {
      const page = await browser.newPage();
      await page.goto(`${site.url.href}${name}`);
      await snapshot(page, name, { dir, ignore: [".player"] });
      await page.close();
    }),
  );
  const manifest = await readManifest(dir);
  expect(manifest.snapshots.map((e) => e.name)).toEqual(names);
});

test("a name that climbs out of the dir is refused", async ({ page }) => {
  await page.goto(site.url.href);
  await expect(snapshot(page, "../out", { dir: join(work, "bad") })).rejects.toThrow(/outside/);
});

test("a second variant of the same shot is refused, not silently replaced", async ({ page }) => {
  const dir = join(work, "clash");
  await page.goto(site.url.href);
  await snapshot(page, "home", { variant: "signed-in", dir });
  await expect(snapshot(page, "home", { variant: "signed-out", dir })).rejects.toThrow(/same shot/);
  await snapshot(page, "home", { variant: "signed-in", dir });
});

test("with the README's pinned clock the video stops and the settle still ends", async ({
  page,
}) => {
  const time = new Date("2026-01-01T00:00:00Z");
  await page.addInitScript(keepNativeRaf);
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto(`${site.url.href}watch`);
  const dirs = [join(work, "pinned1"), join(work, "pinned2")];
  for (const dir of dirs) await snapshot(page, "watch", { dir });
  const [first, second] = await Promise.all(
    dirs.map(async (d) =>
      Buffer.from(await Bun.file(join(d, "watch/1280x720-light.png")).arrayBuffer()),
    ),
  );
  expect(diffPngs(first!, second!).changed).toBe(false);
});
