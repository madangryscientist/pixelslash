import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { SHA_MAIN, WHITE, open, provision, uploadBuild } from "./api-upload";
import { showPanel } from "./snapshot-viewer";
import { createProject, openSettings } from "./orgs-page";
import { SERVER } from "./ports";

/**
 * Twin snapshots (PS-295): a web and an android `Button/primary` dark in one build are twins, and
 * an android-only `Button/loading` is named as unlinked, on the build page and in the side panel.
 */

const SHOTS = join(homedir(), ".cache", "tmp", "ps-295-shots");

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

async function idsByName(token: string, buildId: string) {
  const res = await fetch(`${SERVER}/api/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { build }: { build: { snapshots: { id: string; name: string; platform: string }[] } } =
    await res.json();
  return build.snapshots;
}

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

test("a web and an android shot of one name and theme are twins; an android-only one is unlinked", async ({
  page,
}) => {
  await mkdir(SHOTS, { recursive: true });
  const { token, projectId } = await provision(page, "Twin Co", "twins");
  const buildId = await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "Button/primary", png: WHITE, meta: { theme: "dark" } },
    { name: "Button/primary", png: WHITE, meta: ANDROID },
    { name: "Button/loading", png: WHITE, meta: ANDROID },
  ]);

  // The build page names the shot that has no web twin, and only that one.
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  const unlinked = page.getByTestId("unlinked");
  await expect(unlinked).toContainText("Button/loading dark has no web twin");
  await expect(unlinked.getByTestId("unlinked-shot")).toHaveCount(1);
  await shoot(page, "build-unlinked", "light", unlinked);
  await shoot(page, "build-unlinked", "dark", unlinked);

  // The web shot's side panel lists its android twin, labelled by platform and device.
  const shots = await idsByName(token, buildId);
  const [web, android] = ["linux", "android"].map((p) =>
    shots.find((s) => s.name === "Button/primary" && s.platform === p),
  );
  expect(web && android).toBeTruthy();
  await open(page, `/projects/${projectId}/builds/${buildId}/snapshots/${web?.id}`);
  await showPanel(page);
  const twins = page.getByTestId("twins");
  await expect(twins.getByTestId("twin")).toHaveCount(1);
  await expect(twins).toContainText("android · Pixel 8 API 35");
  await expect(twins).toContainText("same build");
  await shoot(page, "side-panel-twins", "light", twins);
  await shoot(page, "side-panel-twins", "dark", twins);

  // The link goes to the twin, whose own panel links back to the web shot.
  await twins.getByRole("link", { name: "android · Pixel 8 API 35" }).click();
  await expect(page).toHaveURL(new RegExp(`/snapshots/${android?.id}$`));
  await showPanel(page);
  await expect(page.getByTestId("twins")).toContainText("web");
});

test("the project settings link a twin project of the same org, and clear it", async ({ page }) => {
  const { projectId } = await provision(page, "Link Co", "app");
  await open(page, `/projects/${projectId}/settings`);
  // A one-project org has nothing to link to.
  await expect(page.getByTestId("no-twin-options")).toBeVisible();

  // Add a second project from the org page, then link it to the first.
  await page.goBack();
  await createProject(page, "native");
  await openSettings(page, "native");
  const card = page.getByTestId("twin-project");
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await card.getByLabel("Twin project").selectOption({ label: "app" });
  await card.getByRole("button", { name: "Save twin project" }).click();
  await page.reload();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(card.getByLabel("Twin project")).toHaveValue(projectId);
});
