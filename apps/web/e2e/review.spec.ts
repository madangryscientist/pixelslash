import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { type Browser, type Locator, type Page, expect, test } from "@playwright/test";
import { expectBuildWorkspaceOpen, walkBuildTabs } from "./build-workspace";
import { checkout, removeHistoryRepo } from "./history-repo";
import { createOrg, createProject, openSettings } from "./orgs-page";
import { SERVER } from "./ports";
import { rejectThenWalkFailedBuild } from "./review-keys";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");
/** Screens I actually looked at; kept outside the wiped e2e state. */
const SHOTS = process.env["PS_SHOT_DIR"] ?? join(WEB, ".wrangler/e2e/shots");

// Three uploads plus two diffed builds are slower than Playwright's default.
test.describe.configure({ timeout: 180_000 });

/* ------------------------------------------------------------------ PNG fixtures, no browser */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

type Block = { x: number; y: number; w: number; h: number; rgb: [number, number, number] };

/** A white RGBA PNG with opaque blocks painted on it: enough to be `changed`, no dependency. */
function png(width: number, height: number, blocks: Block[] = []): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 4;
      raw[at] = 255;
      raw[at + 1] = 255;
      raw[at + 2] = 255;
      raw[at + 3] = 255;
    }
  }
  for (const block of blocks) {
    for (let y = block.y; y < block.y + block.h; y += 1) {
      for (let x = block.x; x < block.x + block.w; x += 1) {
        const at = y * stride + 1 + x * 4;
        raw[at] = block.rgb[0];
        raw[at + 1] = block.rgb[1];
        raw[at + 2] = block.rgb[2];
        raw[at + 3] = 255;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------------------- upload fixtures */

type Fixture = { name: string; png: Buffer };

const temps: string[] = [];

test.afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  removeHistoryRepo();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** The same shape the CLI's manifest reader wants; the viewport is metadata, the PNG is truth. */
async function snapshotDir(shots: Fixture[]): Promise<string> {
  const dir = await tempDir("ps-review-");
  const entries = [];
  for (const shot of shots) {
    await writeFile(join(dir, `${shot.name}.png`), shot.png);
    entries.push({
      name: shot.name,
      path: `/${shot.name}`,
      variant: {
        name: "desktop",
        browser: "chromium",
        viewport: { width: 1280, height: 720 },
        theme: "light",
      },
      tags: ["web"],
      diff: { threshold: 0.2 },
      file: `${shot.name}.png`,
      fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
    });
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: entries }));
  return dir;
}

/** The real CLI against the running app; returns the new build id. */
function upload(dir: string, token: string, branch: string, pr?: number): string {
  const repo = checkout(branch === "main" ? "main" : "work");
  const args = [CLI, "upload", dir, "--server", SERVER, "--branch", branch];
  if (pr !== undefined) args.push("--pr", String(pr));
  const res = spawnSync("bun", args, {
    cwd: repo,
    env: { ...process.env, PIXELSLASH_TOKEN: token },
    encoding: "utf8",
  });
  const id = /build: (\S+)/.exec(res.stdout)?.[1];
  if (res.status !== 0 || !id) throw new Error(`upload failed: ${res.stdout}${res.stderr}`);
  return id;
}

const RED: [number, number, number] = [220, 30, 30];
const BASE: Fixture[] = [
  { name: "home", png: png(40, 40) },
  { name: "about", png: png(40, 40) },
  { name: "contact", png: png(40, 40) },
  { name: "hero", png: png(40, 40) },
];
/** Two changed shots (one only by size), one new, one removed, one unchanged. */
const REVIEW: Fixture[] = [
  { name: "home", png: png(40, 40) },
  { name: "about", png: png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: RED }]) },
  { name: "hero", png: png(48, 40, [{ x: 42, y: 10, w: 4, h: 10, rgb: RED }]) },
  { name: "pricing", png: png(40, 40) },
];

/* --------------------------------------------------------------------------------- the walk */

async function submit(input: Locator, value: string, button: Locator) {
  await input.fill(value);
  await button.click();
}

/** Sign in through the GitHub stub and make one org with one project and one CI token. */
async function provision(page: Page): Promise<{ token: string; projectId: string }> {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  const orgId = await createOrg(page, "Review Co");
  await createProject(page, "shop");
  await openSettings(page, "shop");
  await submit(
    page.getByLabel("Token name, e.g. github-actions"),
    "ci",
    page.getByRole("button", { name: "Issue token" }),
  );
  const token = (await page.getByTestId("issued-token").textContent()) ?? "";
  await page.goto(`/orgs?org=${orgId}`);
  await page.getByRole("link", { name: "shop", exact: true }).click();
  const projectId = /\/projects\/([^/]+)/.exec(page.url())?.[1];
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  return { token, projectId };
}

/** A full load, then wait for hydration: before it a click or key can be lost. */
async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
}

async function capture(page: Page, name: string) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

function group(page: Page, name: string) {
  return page.getByTestId(`group-${name}`);
}

/** A rival member: a real user in another org, with a session inserted straight into D1. */
/** One statement against the running e2e D1, as the wrangler CLI does. */
function sql(command: string) {
  return spawnSync(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      ".wrangler/e2e",
      "--command",
      command,
    ],
    { cwd: WEB, encoding: "utf8" },
  );
}

async function rivalSession(): Promise<string> {
  const token = "pss_e2e_rival";
  const hash = createHash("sha256").update(token).digest("hex");
  const user = sql("INSERT INTO users (id, github_id, login) VALUES ('rival-user', 9999, 'rival')");
  const org = sql("INSERT INTO orgs (id, name) VALUES ('rival-org', 'Rival Co')");
  const member = sql("INSERT INTO members (org_id, user_id) VALUES ('rival-org', 'rival-user')");
  const session = sql(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ('${hash}', 'rival-user', ${Date.now() + 3_600_000})`,
  );
  for (const result of [user, org, member, session]) {
    if (result.status !== 0) throw new Error(`seeding the rival failed: ${result.stderr}`);
  }
  return token;
}

async function rivalGets404(browser: Browser, projectId: string, buildId: string) {
  const token = await rivalSession();
  const context = await browser.newContext();
  await context.addCookies([{ name: "ps_session", value: token, url: SERVER }]);
  const page = await context.newPage();
  await page.goto("/orgs");
  await expect(page.getByRole("heading", { name: "Rival Co" })).toBeVisible();
  const response = await page.goto(`/projects/${projectId}/builds/${buildId}`);
  expect(response?.status()).toBe(404);
  await context.close();
}

test("the review screens: j/k walk, overlay from stored regions, accept, reject, accept all", async ({
  page,
  browser,
}) => {
  const { token, projectId } = await provision(page);

  upload(await snapshotDir(BASE), token, "main");
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  upload(await snapshotDir(REVIEW), token, "review", 7);

  // The project page: newest first, with the counts the build measured.
  await open(page, `/projects/${projectId}`);
  const rows = page.getByTestId("build-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("review");
  await expect(rows.first()).toContainText("2 changed · 1 new · 1 removed · 1 unchanged");
  await expect(rows.first()).toContainText("5 pending");
  await expect(rows.first().getByTestId("build-status")).toHaveText("changes");
  await capture(page, "01-project");

  // The build page: five shots in their groups.
  await rows.first().getByRole("link", { name: "review" }).click();
  const buildUrl = page.url();
  const buildId = /\/builds\/([^/]+)/.exec(buildUrl)?.[1] ?? "";
  await expectBuildWorkspaceOpen(page);
  await capture(page, "02-build");
  await walkBuildTabs(page);

  // The changed shot: both modes, boxes from the stored regions, signed image URLs.
  await group(page, "changed").getByRole("link", { name: /about/i }).click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.getByTestId("position")).toHaveText("1 of 5");
  await expect(page.getByTestId("sizes")).toContainText("compared at 40×40");
  await expect(page.getByTestId("diff-options")).toContainText("threshold");
  await expect(page.getByTestId("diff-options")).toContainText("0.2");
  const src = await page.locator("img").first().getAttribute("src");
  expect(src).toMatch(/^\/images\/orgs\/.+\?exp=\d+&sig=.+$/);
  expect((await page.request.get(SERVER + src)).status()).toBe(200);
  expect(
    (
      await page.request.get(SERVER + (src ?? "").replace("/images/orgs/", "/images/orgs/x/"))
    ).status(),
  ).toBe(404);
  await capture(page, "03-snapshot-side-by-side");

  await page.getByRole("button", { name: "Overlay" }).click();
  await expect(
    page.locator('svg[aria-label="Measured regions"] rect[data-kind="change"]').first(),
  ).toBeVisible();
  await capture(page, "04-snapshot-overlay");

  await page.getByRole("button", { name: "Slider" }).click();
  await page.getByLabel("Compare position").fill("70");
  await expect(page.getByLabel("Compare position")).toHaveValue("70");
  await capture(page, "05-snapshot-slider");

  // j walks to the next shot in the build's order; k comes back.
  await page.locator("h1").click();
  await page.keyboard.press("j");
  await expect(page.getByTestId("position")).toHaveText("2 of 5");
  await expect(page.getByTestId("sizes")).toContainText("Main 40×40 · Branch 48×40");
  await expect(page.getByTestId("sizes")).toContainText("not painted as changed");
  await page.keyboard.press("k");
  await expect(page.getByTestId("position")).toHaveText("1 of 5");

  // a accepts the shot on screen.
  await page.keyboard.press("a");
  await expect(page.getByTestId("review-state")).toHaveText("accepted by e2e-octocat");
  await open(page, buildUrl);
  await expect(page.getByText("1 to review")).toBeVisible();

  // r rejects the size-changed shot and the build fails.
  await group(page, "changed").getByRole("link", { name: /hero/i }).click();
  await expect(page.getByTestId("position")).toHaveText("2 of 5");
  await rejectThenWalkFailedBuild(page);
  await open(page, buildUrl);
  await expect(page.getByTestId("build-status")).toHaveText("failed");
  await expect(page.getByRole("button", { name: "Accept all" })).toBeDisabled();
  await capture(page, "06-build-after-reject");

  // A new build carries the same shots: accept all clears it to passed.
  await page.waitForTimeout(1100);
  upload(await snapshotDir(REVIEW), token, "review");
  await open(page, `/projects/${projectId}`);
  await expect(page.getByTestId("build-row").first()).toContainText("5 pending");
  await page.getByTestId("build-row").first().getByRole("link", { name: "review" }).click();
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByTestId("build-status")).toHaveText("passed");
  await expect(page.getByText("nothing to review")).toBeVisible();
  await expect(page.getByTestId("review-state").first()).toHaveText(/accepted by e2e-octocat/);
  await capture(page, "07-build-accepted-all");

  await rivalGets404(browser, projectId, buildId);
});
