import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Locator, type Page, expect, test } from "@playwright/test";
import { expectApprovedEarlier } from "./approved-earlier";
import { JUDGE_SAYS, expectBranchPage } from "./branch-page";
import { png } from "./png";
import { expectBaselineBuild, expectBuildWorkspaceOpen, walkBuildTabs } from "./build-workspace";
import { checkout, removeHistoryRepo } from "./history-repo";
import { expectProjectFlag, flagFalsePositive } from "./detection-flag";
import { createOrg, createProject, openSettings } from "./orgs-page";
import { SERVER } from "./ports";
import { rejectThenWalkFailedBuild } from "./review-keys";
import { rivalContext, rivalSession } from "./rival";
import { checkSnapshotViewer } from "./snapshot-viewer";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");
/** Screens I actually looked at; kept outside the wiped e2e state. */
const SHOTS = process.env["PS_SHOT_DIR"] ?? join(WEB, ".wrangler/e2e/shots");

// Three uploads plus two diffed builds are slower than Playwright's default.
test.describe.configure({ timeout: 180_000 });

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

/**
 * The real CLI against the running app; returns the new build id. It runs in `history-repo`, not the
 * worktree: the server only takes a baseline at the branch build's merge-base or an ancestor, so a
 * worktree HEAD ahead of `origin/main` would make every shot `new`.
 */
/** `pr` is sent as `--pr`; `judge`, a dir holding a stub judge, runs the upload with `--judge`. */
function upload(
  dir: string,
  token: string,
  branch: string,
  { pr, judge }: { pr?: number; judge?: string } = {},
): string {
  const repo = checkout(branch === "main" ? "main" : "work");
  const args = [CLI, "upload", dir, "--server", SERVER, "--branch", branch];
  if (pr !== undefined) args.push("--pr", String(pr));
  if (judge) args.push("--judge");
  // A judge dir first on PATH holds a stub `mlx_vlm.generate`, found before any real model.
  const PATH = judge ? `${judge}:${process.env["PATH"]}` : process.env["PATH"];
  const res = spawnSync("bun", args, {
    cwd: repo,
    env: { ...process.env, PATH, PIXELSLASH_TOKEN: token },
    encoding: "utf8",
  });
  const id = /build: (\S+)/.exec(res.stdout)?.[1];
  if (res.status !== 0 || !id) throw new Error(`upload failed: ${res.stdout}${res.stderr}`);
  return id;
}

/** A dir holding a stub local judge that says `JUDGE_SAYS` of every shot it is shown. */
async function stubJudge(): Promise<string> {
  const dir = await tempDir("ps-judge-");
  const bin = join(dir, "mlx_vlm.generate");
  await writeFile(bin, `#!/bin/sh\necho "CHANGE ${JUDGE_SAYS}."\n`, { mode: 0o755 });
  return dir;
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
async function provision(
  page: Page,
  orgName = "Review Co",
): Promise<{ token: string; projectId: string }> {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  const orgId = await createOrg(page, orgName);
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

/** The shot's image is a signed URL that serves, and the same path in another org's prefix does not. */
async function expectSignedImage(page: Page) {
  const src = await page.locator("img").first().getAttribute("src");
  expect(src).toMatch(/^\/images\/orgs\/.+\?exp=\d+&sig=.+$/);
  expect((await page.request.get(SERVER + src)).status()).toBe(200);
  expect(
    (
      await page.request.get(SERVER + (src ?? "").replace("/images/orgs/", "/images/orgs/x/"))
    ).status(),
  ).toBe(404);
}

function group(page: Page, name: string) {
  return page.getByTestId(`group-${name}`);
}

async function rivalGets404(browser: Browser, projectId: string, buildId: string) {
  const context = await rivalContext(browser, await rivalSession());
  const page = await context.newPage();
  await page.goto("/orgs");
  await expect(page.getByRole("heading", { name: "Rival Co" })).toBeVisible();
  const response = await page.goto(`/projects/${projectId}/builds/${buildId}`);
  expect(response?.status()).toBe(404);
  await context.close();
}

/** The review fixtures once more, a second later, then the project page. */
async function reupload(page: Page, token: string, projectId: string) {
  await page.waitForTimeout(1100);
  upload(await snapshotDir(REVIEW), token, "review");
  await open(page, `/projects/${projectId}`);
}

test("the review screens: j/k walk, overlay from stored regions, accept, reject, accept all", async ({
  page,
  browser,
}) => {
  const { token, projectId } = await provision(page);

  upload(await snapshotDir(BASE), token, "main");
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  upload(await snapshotDir(REVIEW), token, "review", { pr: 7 });

  // The project page: newest first, with the counts the build measured.
  await open(page, `/projects/${projectId}`);
  const rows = page.getByTestId("build-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("review");
  await expect(rows.first()).toContainText("2 changed · 1 new · 1 removed · 1 unchanged");
  await expect(rows.first().getByTestId("to-review")).toHaveText("2 to review");
  await expect(rows.first().getByTestId("build-status")).toHaveText("changes");
  await capture(page, "01-project");

  await expectBaselineBuild(page, rows.last());

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
  await expectSignedImage(page);
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
  await checkSnapshotViewer(page);
  await flagFalsePositive(page);
  await capture(page, "05b-snapshot-flagged");

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
  // Accepting does not clear a flag: the two are independent.
  await expect(page.getByTestId("detection-flag")).toHaveCount(1);
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
  await expect(page.getByTestId("build-row").first().getByTestId("to-review")).toHaveText(
    "2 to review",
  );
  // The flag on the earlier build stays listed, and the export is exactly it.
  await expectProjectFlag(page, projectId);
  await page.getByTestId("build-row").first().getByRole("link", { name: "review" }).click();
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByTestId("build-status")).toHaveText("passed");
  await expect(page.getByText("nothing to review")).toBeVisible();
  await expect(page.getByTestId("review-state").first()).toHaveText(/accepted by e2e-octocat/);
  await capture(page, "07-build-accepted-all");
  // The same pixels again: unchanged against the accepted build, and it says the change was approved.
  await expectApprovedEarlier(page, () => reupload(page, token, projectId), capture);

  await rivalGets404(browser, projectId, buildId);
});

test("the branch page: against main, since last build, and an accept the build page agrees with", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Branch Co");
  upload(await snapshotDir(BASE), token, "main");
  await page.waitForTimeout(1100);
  upload(await snapshotDir(REVIEW), token, "feature", { judge: await stubJudge() });
  await open(page, `/projects/${projectId}`);
  await expectBranchPage(page, projectId, "feature", capture);
});
