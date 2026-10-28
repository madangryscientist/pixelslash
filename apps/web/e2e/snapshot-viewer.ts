import { expect, type Page } from "@playwright/test";

/** Opens one of the side panel's disclosures ("Details" or "Tools") unless it is open already. */
export async function openSection(page: Page, name: "Details" | "Tools") {
  const toggle = page.getByRole("button", { name, exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

const BOXES = 'svg[aria-label="Measured regions"] rect[data-kind="change"]';

/**
 * On the first changed shot at 1440×900: the decision stays on screen in every view mode, the
 * highlight and zoom act on the stored regions, and `?` lists the keys. Leaves the page at Fit,
 * highlight on, side by side.
 */
export async function checkSnapshotViewer(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("review-position")).toHaveText("1 / 2 with a change");
  await expect(page.getByTestId("color-scheme")).toContainText("prefers-color-scheme:");

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  for (const mode of ["Overlay", "Slider", "Side by side"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click();
    await expect(accept).toBeInViewport();
    await expect(reject).toBeInViewport();
  }

  // The highlight is one switch for every mode.
  await expect(page.locator(BOXES).first()).toBeVisible();
  await page.getByRole("button", { name: "Highlight" }).click();
  await expect(page.locator(BOXES)).toHaveCount(0);
  await page.getByRole("button", { name: "Highlight" }).click();
  await expect(page.locator(BOXES).first()).toBeVisible();

  await page.getByRole("radio", { name: "Zoom to change" }).click();
  await expect(page.locator('[data-scale="zoom"]').first()).toBeVisible();
  await page.getByRole("radio", { name: "Fit", exact: true }).click();
  await expect(page.locator('[data-scale="zoom"]')).toHaveCount(0);

  // `?` opens the list of keys; Esc closes it and the keys work again.
  await page.locator("h1").click();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await expect(help).toContainText("Next shot");
  await expect(help).toContainText("Reject this shot");
  // Under the list no key walks or decides, even with focus off its buttons.
  const position = await page.getByTestId("position").textContent();
  await help.getByRole("heading").click();
  await page.keyboard.press("j");
  await expect(page.getByTestId("position")).toHaveText(position ?? "");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
}
