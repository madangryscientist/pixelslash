import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { SHA_MAIN, WHITE, open, provision, uploadBuild } from "./api-upload";
import { showPanel } from "./snapshot-viewer";
import { png } from "./png";
import { SERVER } from "./ports";

/**
 * The parity view (PS-298): a web and an android `Button/primary` dark, each with a metrics file,
 * opened side by side from the side panel's Twins row. The android column, the `no ios twin`
 * column and a metrics sentence are on the page; a web-only project has no link to it.
 */

const SHOTS = join(homedir(), ".cache", "tmp", "ps-298-shots");

const WEB_SHOT = png(160, 120, [{ x: 20, y: 20, w: 60, h: 40, rgb: [220, 30, 30] }]);
const NATIVE_SHOT = png(480, 360, [{ x: 60, y: 60, w: 180, h: 120, rgb: [220, 30, 30] }]);

const native = (platform: "android" | "ios", device: string, viewport: string) => ({
  platform,
  browser: device,
  viewport,
  theme: "dark",
  tags: ["native"],
  fingerprint: {
    image: "external",
    browser: "external",
    fonts: "unknown",
    platform,
    device,
    scale: "3",
  },
});
const ANDROID = native("android", "Pixel 8 API 35", "412x915");
const IOS = native("ios", "iPhone 15", "393x852");

const metrics = (h: number) =>
  JSON.stringify({
    version: "1.0",
    root: "button",
    parts: { button: { box: { x: 0, y: 0, w: 96, h } } },
  });

async function snapshotIds(token: string, buildId: string) {
  const res = await fetch(`${SERVER}/api/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { build }: { build: { snapshots: { id: string; name: string; platform: string }[] } } =
    await res.json();
  return build.snapshots;
}

async function shoot(page: Page, name: string, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^((?!dark).)*$/);
  await page.locator("main").screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
}

test("the side panel opens the parity view: web and android side by side, no ios twin, a metrics sentence", async ({
  page,
}) => {
  await mkdir(SHOTS, { recursive: true });
  const { token, projectId } = await provision(page, "Parity Co", "parity");
  const buildId = await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "Button/primary", png: WEB_SHOT, meta: { theme: "dark" }, metrics: metrics(40) },
    { name: "Button/primary", png: NATIVE_SHOT, meta: ANDROID, metrics: metrics(44) },
  ]);
  const shots = await snapshotIds(token, buildId);
  const web = shots.find((s) => s.name === "Button/primary" && s.platform === "linux");
  expect(web).toBeTruthy();

  await open(page, `/projects/${projectId}/builds/${buildId}/snapshots/${web?.id}`);
  await showPanel(page);
  await page.getByTestId("twins").getByTestId("compare-platforms").click();
  await expect(page).toHaveURL(/\/builds\/[^/]+\/parity\?/);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  // Web, android, ios in that order; ios has no shot and says so.
  const columns = page.getByTestId("parity-column");
  await expect(columns).toHaveCount(2);
  await expect(columns.nth(0)).toHaveAttribute("data-platform", "web");
  await expect(columns.nth(1)).toHaveAttribute("data-platform", "android");
  await expect(columns.nth(1)).toContainText("Pixel 8 API 35");
  await expect(page.getByTestId("parity-missing")).toContainText(
    "Button/primary dark has no ios twin",
  );

  // Same physical size: 160x120 px at 1x and 480x360 px at 3x are both 160x120.
  const physical = page.getByTestId("parity-physical");
  await expect(physical.nth(0)).toContainText("160");
  await expect(physical.nth(1)).toContainText("3x");
  await expect(physical.nth(1)).toContainText("160");

  // The hint is labelled as one, and the metrics sentence is the CLI's.
  await expect(page.getByTestId("parity-similarity")).toContainText("a hint");
  await expect(page.getByTestId("parity-mismatch").first()).toContainText(
    "button height 40 web vs 44 android",
  );
  await expect(page.getByTestId("parity-manifest-notice")).toBeVisible();

  await shoot(page, "parity-missing-ios", "light");
  await shoot(page, "parity-missing-ios", "dark");

  // A column links to that shot's own review page.
  await page.getByTestId("parity-shot-link").nth(1).click();
  await expect(page).toHaveURL(/\/snapshots\/[^/]+$/);
});

test("all three platforms side by side, and an unlinked shot opens the view", async ({ page }) => {
  await mkdir(SHOTS, { recursive: true });
  const { token, projectId } = await provision(page, "Parity Three Co", "three");
  const buildId = await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "Button/primary", png: WEB_SHOT, meta: { theme: "dark" }, metrics: metrics(40) },
    { name: "Button/primary", png: NATIVE_SHOT, meta: ANDROID, metrics: metrics(44) },
    { name: "Button/primary", png: NATIVE_SHOT, meta: IOS },
    { name: "Button/loading", png: NATIVE_SHOT, meta: IOS },
  ]);

  // An unlinked entry carries the link too.
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("unlinked-shot").getByTestId("compare-platforms").click();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByTestId("parity-missing")).toHaveCount(2);
  await expect(page.getByTestId("parity-missing").first()).toContainText(
    "Button/loading dark has no web twin",
  );

  await open(
    page,
    `/projects/${projectId}/builds/${buildId}/parity?name=Button%2Fprimary&theme=dark`,
  );
  const columns = page.getByTestId("parity-column");
  await expect(columns).toHaveCount(3);
  await expect(columns.nth(2)).toHaveAttribute("data-platform", "ios");
  await expect(page.getByTestId("parity-missing")).toHaveCount(0);
  // The ios shot has no metrics file: not measured, never drift.
  await expect(page.getByTestId("parity-pair").filter({ hasText: "ios" }).first()).toContainText(
    "not measured",
  );
  await shoot(page, "parity-three", "light");
  await shoot(page, "parity-three", "dark");
});

test("a web-only project has no Compare platforms link", async ({ page }) => {
  const { token, projectId } = await provision(page, "Web Only Co", "webonly");
  const buildId = await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "Button/primary", png: WHITE, meta: { theme: "dark" } },
  ]);
  const shots = await snapshotIds(token, buildId);
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("compare-platforms")).toHaveCount(0);
  await open(page, `/projects/${projectId}/builds/${buildId}/snapshots/${shots[0]?.id}`);
  await expect(page.getByTestId("compare-platforms")).toHaveCount(0);
});
