import type { Locator, Page } from "@playwright/test";

/**
 * The header's site nav as a reader sees it. AppShell (@hackcove/ui-react 0.9) renders the nav twice,
 * a row on a desktop and the same links under a "Menu" button on a phone, so the test id names two
 * elements and only one is visible. On a phone the Menu is opened first, as a reader would.
 */
export async function siteNav(page: Page): Promise<Locator> {
  const menu = page.locator("header summary", { hasText: /^\s*Menu\s*$/ });
  if (await menu.isVisible()) {
    const open = await menu.evaluate((summary) => summary.closest("details")?.open === true);
    if (!open) await menu.click();
  }
  return page.getByTestId("site-nav").filter({ visible: true });
}
