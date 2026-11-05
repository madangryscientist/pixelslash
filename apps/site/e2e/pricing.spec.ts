import { expect, test } from "@playwright/test";
import { ACTION, STATEMENT } from "../src/content/pricing.ts";

/*
 * The page leads and fills: the first screen is one statement and one action, and the facts reach past
 * two thirds of the header's width. That the action's page exists, and that nothing scrolls sideways on
 * a phone, are every page's checks, in smoke.spec.ts.
 */
test("pricing leads with one statement and one action, and fills", async ({ page }) => {
  await page.goto("/pricing", { waitUntil: "networkidle" });

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(STATEMENT);
  await expect(main.getByRole("heading", { level: 1 })).toBeInViewport();
  await expect(main.getByTestId("pricing-action")).toBeInViewport();
  await expect(main.getByTestId("pricing-action")).toHaveAttribute("href", ACTION.href);
  // The contact address under Questions is the only other link.
  await expect(main.locator('a:not([href^="mailto:"])')).toHaveCount(1);

  const header = await page.getByRole("banner").boundingBox();
  const facts = await main.getByTestId("pricing-facts").boundingBox();
  if (!header || !facts) throw new Error("the header or the facts did not lay out");
  expect(facts.x + facts.width).toBeGreaterThan(header.x + (header.width * 2) / 3);
});
