import { type Page, expect, test } from "@playwright/test";
import { SHA_MAIN, SHA_WORK, explained, open, provision, uploadBuild } from "./api-upload";
import { png } from "./png";
import { STUB } from "./ports";
import { highlightToggle, showPanel } from "./snapshot-viewer";

/**
 * The compare view of one changed shot (PS-410): it fits a phone, the judge status, the slider's
 * divider, the highlight that starts off, the overlay's opacity, the labelled counters, the share
 * of changed pixels, and the side panel that folds away at Fit so the panes get the width.
 *
 * The shots are 1300 px wide: Fit never draws a shot past its own pixels, so a 40 px fixture
 * could not show how much of the view the panes take.
 */

const MAIN = png(1300, 500);
const BRANCH = png(1300, 500, [{ x: 100, y: 100, w: 400, h: 200, rgb: [220, 30, 30] }]);

const PANEL = (page: Page) => page.getByRole("complementary", { name: "Review panel" });

/** A changed shot (`hero`) and an unchanged one, opened on the changed one. */
async function openChangedShot(page: Page) {
  const { token, projectId } = await provision(page, "Compare Co", "compare");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: MAIN },
    { name: "footer", png: MAIN },
  ]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [
      { name: "hero", png: BRANCH },
      { name: "footer", png: MAIN },
    ],
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
}

test("a phone gets the controls, the image and the panel stacked, with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChangedShot(page);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  // Below `lg` the panel is never folded away: it stacks under the image.
  await expect(PANEL(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Side panel", exact: true })).toHaveCount(0);
  expect(await fits()).toBe(true);
  for (const mode of ["Overlay", "Slider", "Side by side"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click();
    expect(await fits(), `${mode} at 390px`).toBe(true);
  }
  for (const scale of ["1:1", "Zoom to change", "Fit"]) {
    await page.getByRole("radio", { name: scale, exact: true }).click();
    expect(await fits(), `${scale} at 390px`).toBe(true);
  }
});

test("labelled counters, the share of changed pixels, and highlight that starts off", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChangedShot(page);
  await expect(page.getByTestId("review-position")).toHaveText("change 1 of 1");
  await expect(page.getByTestId("position")).toHaveText("shot 1 of 2");

  // Off on load, and the label and aria-pressed say so.
  const highlight = highlightToggle(page);
  await expect(highlight).toHaveAttribute("aria-pressed", "false");
  await expect(highlight).toHaveText("Highlight off");
  await expect(page.locator('svg[aria-label="Measured regions"]')).toHaveCount(0);
  await highlight.click();
  await expect(highlight).toHaveAttribute("aria-pressed", "true");
  await expect(highlight).toHaveText("Highlight on");

  // 400 x 200 changed px of the 1300 x 500 compared area: 12.3%.
  await showPanel(page);
  const changed = page.getByTestId("changed-px");
  await expect(changed).toHaveText(/^[\d,]+ \(12\.3%\)$/);
});

test("the slider's divider is visible on a light and a dark theme", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChangedShot(page);
  await page.getByRole("radio", { name: "Slider", exact: true }).click();
  const divider = page.getByTestId("slider-divider");
  const grip = page.getByTestId("slider-grip");
  const toggle = page.getByTestId("theme-toggle");
  for (const dark of [false, true]) {
    if ((await page.locator("html").getAttribute("class"))?.includes("dark") !== dark)
      await toggle.click();
    await expect(page.locator("html")).toHaveClass(dark ? /dark/ : /^(?!.*dark)/);
    const colour = await divider.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(colour).not.toBe("rgba(0, 0, 0, 0)");
    expect(colour).not.toBe("transparent");
    expect((await divider.boundingBox())?.width).toBeGreaterThanOrEqual(2);
    // The 1px dark edge keeps the white line readable on a light shot.
    expect(await divider.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("1px");
    expect((await grip.boundingBox())?.width).toBeGreaterThanOrEqual(28);
    // The grip is a circle, so it reads as something to take hold of.
    expect(await grip.evaluate((el) => getComputedStyle(el).borderRadius)).not.toBe("0px");
  }
});

test("a shot whose judge failed says so and why, not that there is no judge", async ({ page }) => {
  // The queue tries the shot three times, 10 s then 20 s apart, before it stores why it failed.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token, projectId } = await provision(page, "Judge Co", "judged");
  // The stub answers only to its own key, so any other key makes every call fail.
  const form = page.getByTestId("model-settings");
  await form.getByTestId("model-base-url").fill(`${STUB}/v1`);
  await form.getByTestId("model-name").fill("deepseek-flash");
  await form.getByTestId("model-key").fill("sk-e2e-wrong");
  await form.getByTestId("model-save").click();
  await expect(form.getByTestId("model-key-set")).toBeVisible();
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: MAIN }]);
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: BRANCH }],
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await explained(page, 90_000);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await showPanel(page);
  const failed = page.getByTestId("ai-failed");
  await expect(failed).toContainText("judge failed: ");
  await expect(failed).toContainText("Review the pixels.");
  await expect(page.getByTestId("ai-skip")).toHaveCount(0);
});

test("the view mode picker keeps the chosen mode checked, also across a theme toggle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChangedShot(page);
  const radio = (name: string) => page.getByRole("radio", { name, exact: true });
  for (const mode of ["Slider", "Overlay", "Side by side"]) {
    await radio(mode).click();
    await expect(radio(mode)).toHaveAttribute("aria-checked", "true");
    for (const other of ["Side by side", "Overlay", "Slider"].filter((m) => m !== mode))
      await expect(radio(other)).toHaveAttribute("aria-checked", "false");
    // A theme toggle re-renders the page: the mode stays chosen.
    await page.getByTestId("theme-toggle").click();
    await expect(radio(mode)).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("theme-toggle").click();
    await expect(radio(mode)).toHaveAttribute("aria-checked", "true");
  }
});

test("the overlay's opacity range sets the top layer's opacity", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChangedShot(page);
  await page.getByRole("radio", { name: "Overlay", exact: true }).click();
  const range = page.getByLabel("Overlay opacity");
  const top = page.getByTestId("overlay-top");
  const opacity = () => top.evaluate((el) => getComputedStyle(el).opacity);
  await expect(range).toHaveValue("50");
  expect(await opacity()).toBe("0.5");
  await range.fill("20");
  await expect(range).toHaveValue("20");
  expect(await opacity()).toBe("0.2");
  await range.fill("0");
  expect(await opacity()).toBe("0");
  await range.fill("100");
  expect(await opacity()).toBe("1");
});

test("at Fit, side by side, the side panel folds away and the panes take the width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChangedShot(page);
  const viewer = page.getByRole("region", { name: "Snapshot viewer" });
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });

  // Fit and side by side: the panel is folded, and the two panes fill the view.
  await expect(PANEL(page)).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const view = await viewer.boundingBox();
  const panes = await viewer
    .locator("figure")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(panes).toHaveLength(2);
  const [first = 0, second = 0] = panes;
  expect(first + second).toBeGreaterThanOrEqual((view?.width ?? 0) * 0.9);

  // The toggle brings it back, and a second press folds it again.
  await toggle.click();
  await expect(PANEL(page)).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const narrowed = await viewer.locator("figure").first().boundingBox();
  expect(narrowed?.width).toBeLessThan(first);
  await toggle.click();
  await expect(PANEL(page)).toHaveCount(0);

  // Off Fit, or off side by side, the panel is always there and there is nothing to toggle.
  await page.getByRole("radio", { name: "1:1", exact: true }).click();
  await expect(PANEL(page)).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await page.getByRole("radio", { name: "Fit", exact: true }).click();
  await expect(PANEL(page)).toHaveCount(0);
  await page.getByRole("radio", { name: "Overlay", exact: true }).click();
  await expect(PANEL(page)).toBeVisible();
});

test("flagging a detection keeps the folded panel open for its form", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChangedShot(page);
  await expect(PANEL(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Flag detection" }).click();
  await expect(PANEL(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Side panel", exact: true })).toBeDisabled();
});
