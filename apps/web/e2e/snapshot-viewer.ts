import { expect, type Page } from "@playwright/test";

/** Opens one of the side panel's disclosures ("Details" or "Tools") unless it is open already. */
export async function openSection(page: Page, name: "Details" | "Tools") {
  await showPanel(page);
  const toggle = page.getByRole("button", { name, exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/**
 * Opens the side panel when it is folded away: at Fit, side by side, on a wide screen, the page
 * gives the panes the whole width and the panel waits behind its toggle (PS-410).
 */
export async function showPanel(page: Page) {
  // The highlight switch is on every compare screen: once it is there the page has settled, so a
  // missing panel toggle means the panel is not foldable (a phone, or 1:1) rather than not drawn yet.
  await expect(highlightToggle(page)).toBeVisible();
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await toggle.count()) === 0) return;
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

/** The highlight toggle: it is off when a shot opens, and its label says which it is. */
export const highlightToggle = (page: Page) =>
  page.getByRole("button", { name: /^Highlight (on|off)$/ });

const BOXES = 'svg[aria-label="Measured regions"] rect[data-kind="change"]';

/**
 * On the first changed shot at 1440×900: the decision stays on screen in every view mode, the
 * highlight (off on load) and zoom act on the stored regions, and `?` lists the keys. Leaves the page
 * at Fit, highlight on, side by side, the side panel open.
 */
export async function checkSnapshotViewer(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await showPanel(page);
  await expect(page.getByTestId("review-position")).toHaveText("change 1 of 3");
  await expect(page.getByTestId("color-scheme")).toContainText("prefers-color-scheme:");

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  for (const mode of ["Overlay", "Slider", "Side by side"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click();
    await expect(accept).toBeInViewport();
    await expect(reject).toBeInViewport();
  }

  // The highlight is one switch for every mode.
  await expect(highlightToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(BOXES)).toHaveCount(0);
  await highlightToggle(page).click();
  await expect(highlightToggle(page)).toHaveText("Highlight on");
  await expect(page.locator(BOXES).first()).toBeVisible();
  await highlightToggle(page).click();
  await expect(page.locator(BOXES)).toHaveCount(0);
  await highlightToggle(page).click();
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

/**
 * Overlay then slider on the changed shot, each captured: the boxes come from the stored regions
 * once the highlight is on, the divider takes a value, and the highlight is put back to off.
 */
export async function walkViewModes(
  page: Page,
  capture: (page: Page, name: string) => Promise<void>,
) {
  await page.getByRole("radio", { name: "Overlay" }).click();
  await highlightToggle(page).click();
  await expect(page.locator(BOXES).first()).toBeVisible();
  await capture(page, "04-snapshot-overlay");

  await page.getByRole("radio", { name: "Slider" }).click();
  await page.getByLabel("Compare position").fill("70");
  await expect(page.getByLabel("Compare position")).toHaveValue("70");
  await capture(page, "05-snapshot-slider");
  // The viewer check starts from a shot as it opens, highlight off.
  await highlightToggle(page).click();
  await expect(highlightToggle(page)).toHaveText("Highlight off");
}
