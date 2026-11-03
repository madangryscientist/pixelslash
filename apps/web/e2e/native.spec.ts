import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { open, provision } from "./api-upload";
import { png } from "./png";
import { SERVER } from "./ports";
import { openSection } from "./snapshot-viewer";

/**
 * Native screenshots (PS-293): PNGs a Maestro run wrote, imported as android with a device and a
 * scale, uploaded by the real CLI, and diffed on the server against their own baseline. A web shot
 * in the same project is left exactly as it was.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");

const temps: string[] = [];
test.afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("bun", [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function rows(sql: string): Promise<Record<string, string>[]> {
  const { stdout } = await run(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--json",
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      ".wrangler/e2e",
      "--command",
      sql,
    ],
    { cwd: WEB },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("[")))[0].results;
}

// A 360×720 px screen at scale 3 is a 120×240 viewport; the red block is the change.
const SCREEN = png(360, 720);
const MOVED = png(360, 720, [{ x: 30, y: 60, w: 90, h: 60, rgb: [220, 30, 30] }]);

/** A generated dir of loose PNGs: the shape Maestro leaves, with no binary checked in. */
async function pngs(prefix: string, shots: Record<string, Buffer>) {
  const dir = await tempDir(prefix);
  for (const [name, bytes] of Object.entries(shots)) await writeFile(join(dir, name), bytes);
  return dir;
}

async function imported(from: string, ...flags: string[]) {
  const out = join(await tempDir("ps-e2e-native-out-"), "snaps");
  const made = cli(["import", from, "--out", out, ...flags]);
  // The only stderr is the viewport note a native import prints (stdout is unchanged).
  expect(made.stderr.split("\n").filter((l) => l && !l.startsWith("note: "))).toEqual([]);
  expect(made.code).toBe(0);
  return out;
}

/** The web dir and a native dir as one snapshot dir: one build carries both. */
async function together(web: string, native: string) {
  const dir = await tempDir("ps-e2e-both-");
  const manifests = await Promise.all(
    [web, native].map(async (d) => JSON.parse(await readFile(join(d, "manifest.json"), "utf8"))),
  );
  for (const d of [web, native]) await cp(d, dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 1, snapshots: manifests.flatMap((m) => m.snapshots) }),
  );
  return dir;
}

function upload(dir: string, token: string) {
  const res = cli(["upload", dir, "--server", SERVER, "--branch", "main"], {
    PIXELSLASH_TOKEN: token,
  });
  expect(res.code, res.stderr).toBe(0);
  return /build: (\S+)/.exec(res.stdout)?.[1] ?? "";
}

const shotsOf = (buildId: string) =>
  rows(
    `SELECT name, platform, browser, diff_status AS diff, image_key, env_fingerprint AS fp
     FROM snapshots WHERE build_id = '${buildId}' ORDER BY platform, browser`,
  );

test("an android import uploads and diffs against its own baseline; web is untouched; a new device is a re-baseline", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Native Co", "maestro");
  const web = await imported(
    await pngs("ps-e2e-web-", { "home.png": SCREEN }),
    "--viewport",
    "360x720",
  );
  const android = (shots: Record<string, Buffer>, device = "Pixel 8 API 35") =>
    pngs("ps-e2e-droid-", shots).then((from) =>
      imported(from, "--platform", "android", "--device", device, "--scale", "3"),
    );

  // Build 1: a web shot and an android shot in one project; both are new.
  const first = upload(await together(web, await android({ "login.png": SCREEN })), token);
  const one = await shotsOf(first);
  expect(one.map((s) => [s.platform, s.browser, s.diff])).toEqual([
    ["android", "Pixel 8 API 35", "new"],
    ["linux", "chromium", "new"],
  ]);
  expect(Object.keys(JSON.parse(one[1]?.fp ?? ""))).toEqual(["image", "browser", "fonts"]);

  // Build 2: the same two shots, each unchanged against its own baseline.
  const second = upload(await together(web, await android({ "login.png": SCREEN })), token);
  const two = await shotsOf(second);
  expect(two.map((s) => [s.platform, s.diff])).toEqual([
    ["android", "unchanged"],
    ["linux", "unchanged"],
  ]);

  // Build 3: the android shot changed, the web shot did not.
  const third = upload(await together(web, await android({ "login.png": MOVED })), token);
  expect((await shotsOf(third)).map((s) => [s.platform, s.diff])).toEqual([
    ["android", "changed"],
    ["linux", "unchanged"],
  ]);

  // Build 4: another device is another identity: new, and the Pixel 8 shot is removed, never a diff between them.
  const fourth = upload(
    await together(web, await android({ "login.png": MOVED }, "Pixel 6 API 34")),
    token,
  );
  expect((await shotsOf(fourth)).map((s) => [s.platform, s.browser, s.diff])).toEqual([
    ["android", "Pixel 6 API 34", "new"],
    ["android", "Pixel 8 API 35", "removed"],
    ["linux", "chromium", "unchanged"],
  ]);

  // The review page names a device, not a browser, and the scale.
  const [changed] = await rows(
    `SELECT id FROM snapshots WHERE build_id = '${third}' AND platform = 'android'`,
  );
  await open(page, `/projects/${projectId}/builds/${third}/snapshots/${changed?.id}`);
  await openSection(page, "Details");
  const panel = page.getByRole("heading", { name: "Captured in" }).locator("..");
  await expect(panel).toContainText("Platform");
  await expect(panel).toContainText("android");
  await expect(panel).toContainText("Device");
  await expect(panel).toContainText("Pixel 8 API 35");
  await expect(panel).toContainText("3×");
  await expect(panel.getByText("Browser", { exact: true })).toHaveCount(0);
});
