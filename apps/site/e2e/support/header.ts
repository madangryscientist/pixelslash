import type { Locator, Page } from "@playwright/test";

/** What header.spec.ts reads the header with: the scheme, the toggle and boxes. */

/** The class each scheme puts on <html>. */
export const SCHEME_CLASS = { light: "latte", dark: "dark" } as const;
type Scheme = keyof typeof SCHEME_CLASS;
export const other = (scheme: Scheme): Scheme => (scheme === "dark" ? "light" : "dark");

export const toggleOf = (page: Page): Locator => page.getByTestId("theme-toggle");

export async function box(
  locator: Locator,
): Promise<{ x: number; y: number; w: number; h: number }> {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return { x: found.x, y: found.y, w: found.width, h: found.height };
}

/** The scheme classes on <html>: exactly one of them is ever set. */
export async function schemeClasses(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ["dark", "latte"].filter((name) => document.documentElement.classList.contains(name)),
  );
}

/** A click before hydration would do nothing, so wait until React owns the button. */
export async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="theme-toggle"]');
    return button !== null && Object.keys(button).some((key) => key.startsWith("__reactProps"));
  });
}
