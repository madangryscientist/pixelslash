import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";
import { showPanel } from "./snapshot-viewer";
import { SERVER } from "./ports";

/**
 * Stale twins (PS-297): approving a web baseline marks the native twin stale until a reviewer
 * accepts a native shot of that name and theme in a later native build.
 */

const SHOTS = join(homedir(), ".cache", "tmp", "ps-297-shots");

const ANDROID = {
  platform: "android",
  browser: "Pixel 8 API 35",
  viewport: "412x915",
  theme: "dark",
  tags: ["native"],
  fingerprint: {
    image: "external",
    browser: "external",
    fonts: "unknown",
    platform: "android",
    device: "Pixel 8 API 35",
    scale: "2.625",
  },
};

const WEB = { theme: "dark" };
const NAME = "Button/md-primary";
const SHA_NATIVE = "c".repeat(40);
const BRANCH = { mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] };

type StaleReply = {
  stale: { name: string; theme: string; platform: string; sentence: string; cause: object }[];
};

type BuildReply = {
  build: {
    snapshots: {
      id: string;
      name: string;
      platform: string;
      review_state: string;
      awaits_decision?: boolean;
      awaits_reason?: string | null;
    }[];
  };
};

async function stale(token: string, platform = "android"): Promise<StaleReply["stale"]> {
  const res = await fetch(`${SERVER}/api/v1/projects/${PROJECT.id}/stale?platform=${platform}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body: StaleReply = await res.json();
  return body.stale;
}

async function shots(token: string, buildId: string) {
  const res = await fetch(`${SERVER}/api/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body: BuildReply = await res.json();
  return body.build.snapshots;
}

const PROJECT = { id: "" };

async function shoot(
  page: Page,
  name: string,
  scheme: "light" | "dark",
  target = page.locator("main"),
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^((?!dark).)*$/);
  if (page.url().includes("/snapshots/")) await showPanel(page);
  await target.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
}

test("accepting a web change makes the android twin stale until an android shot is accepted", async ({
  page,
}) => {
  await mkdir(SHOTS, { recursive: true });
  const { token, projectId } = await provision(page, "Stale Co", "stale");
  PROJECT.id = projectId;

  // 1. Both platforms in a main build: auto-accepted baselines, nothing stale.
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: NAME, png: WHITE, meta: WEB },
    { name: NAME, png: WHITE, meta: ANDROID },
  ]);
  expect(await stale(token)).toEqual([]);
  await open(page, `/projects/${projectId}`);
  await expect(page.getByTestId("stale-item")).toHaveCount(0);

  // 2. A branch build changes the web shot, and the reviewer accepts it.
  await page.waitForTimeout(1100);
  const webBuild = await uploadBuild(token, { branch: "work", commitSha: SHA_WORK, ...BRANCH }, [
    { name: NAME, png: CHANGED, meta: WEB },
  ]);
  await open(page, `/projects/${projectId}/builds/${webBuild}`);
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByTestId("build-status")).toHaveText("passed");

  // 3. The project page names the stale android twin and the build that changed it.
  const items = await stale(token);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ name: NAME, theme: "dark", platform: "android" });
  expect(items[0]?.sentence).toContain(`${NAME} dark on android is stale: web changed in build `);
  expect(items[0]?.sentence).toContain(`/builds/${webBuild}, accepted by E2E Octocat `);
  await open(page, `/projects/${projectId}`);
  const item = page.getByTestId("stale-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(`${NAME} dark on android is stale: web changed in build`);
  await expect(item).toContainText("accepted by E2E Octocat");
  await expect(item.getByTestId("stale-cause")).toHaveText(webBuild.slice(0, 8));
  await shoot(page, "project-stale-list", "light", page.getByTestId("stale-item"));
  await shoot(page, "project-stale-list", "dark", page.getByTestId("stale-item"));

  // The web shot's side panel carries the badge on its android twin row.
  const web = (await shots(token, webBuild)).find((s) => s.name === NAME);
  expect(web).toBeTruthy();
  await open(page, `/projects/${projectId}/builds/${webBuild}/snapshots/${web?.id}`);
  await showPanel(page);
  const twins = page.getByTestId("twins");
  await expect(twins.getByTestId("stale-badge")).toHaveCount(1);
  await expect(twins.getByTestId("twin-stale-cause")).toContainText("accepted by E2E Octocat");
  await shoot(page, "side-panel-stale-badge", "light", twins);
  await shoot(page, "side-panel-stale-badge", "dark", twins);

  // 4. A later android build leaves the shot unchanged; it stays stale and waits for a reviewer.
  await page.waitForTimeout(1100);
  const nativeBuild = await uploadBuild(
    token,
    { branch: "native", commitSha: SHA_NATIVE, ...BRANCH },
    [{ name: NAME, png: WHITE, meta: ANDROID }],
  );
  expect(await stale(token)).toHaveLength(1);
  const android = (await shots(token, nativeBuild)).find((s) => s.platform === "android");
  expect(android).toMatchObject({
    platform: "android",
    review_state: "pending",
    awaits_decision: true,
    awaits_reason: "stale",
  });
  await open(page, `/projects/${projectId}/builds/${nativeBuild}`);
  await expect(page.getByText("1 to review")).toBeVisible();
  await expect(
    page.getByText("no change here; the web twin changed, so this native shot needs a review"),
  ).toBeVisible();
  await open(page, `/projects/${projectId}/builds/${nativeBuild}/snapshots/${android?.id}`);
  await showPanel(page);
  await expect(page.getByTestId("position")).toHaveText(/of \d/);

  // 5. The reviewer accepts it, and the stale line is gone.
  await page.locator("h1").click();
  await page.keyboard.press("a");
  await expect(page.getByTestId("review-state")).toHaveText("accepted by e2e-octocat");
  expect(await stale(token)).toEqual([]);
  await open(page, `/projects/${projectId}`);
  await expect(page.getByTestId("stale-item")).toHaveCount(0);
});
