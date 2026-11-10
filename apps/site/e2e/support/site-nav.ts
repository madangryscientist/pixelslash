import type { Locator, Page } from "@playwright/test";

/**
 * The header's site nav as a reader sees it. AppShell (@hackcove/ui-react 0.9) renders the nav twice,
 * a row on a desktop and the same links under a "Menu" button on a phone, so the test id names two
 * elements and only one is visible. On a phone the Menu is opened first, as a reader would.
 */
export async function siteNav(page: Page): Promise<Locator> {
  const menu = menuButton(page);
  if ((await menu.isVisible()) && !(await menuOpen(page))) await menu.click();
  return page.getByTestId("site-nav").filter({ visible: true });
}

/** The phone header's Menu button: the `<summary>` of AppShell's `<details>`. */
export const menuButton = (page: Page): Locator =>
  page.locator("header summary", { hasText: /^\s*Menu\s*$/ });

/** Whether the phone header's Menu is open. */
export const menuOpen = (page: Page): Promise<boolean> =>
  page
    .locator("header details")
    .evaluate((element) => element instanceof HTMLDetailsElement && element.open);
