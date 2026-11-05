import { type Page, expect, test } from "@playwright/test";

/*
 * The docs search: the index is one static file on this site's own origin, queried in the browser.
 * Using the box asks for that file and for nothing else, and no request leaves the origin.
 */

/** On a phone the rail is folded under a "Docs" summary: open it, as a reader would. */
async function openRail(page: Page): Promise<void> {
  const fold = page.locator("summary", { hasText: /^Docs$/ });
  if (await fold.isVisible()) await fold.click();
}

test("search finds an exact error message, and no request leaves the origin", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "").origin;
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto("/docs/install", { waitUntil: "networkidle" });
  await openRail(page);
  const box = page.getByTestId("docs-search");
  const first = page.getByTestId("docs-search-results").locator("a").first();
  // Typed before the page hydrated, the text can be lost: type again until the results show.
  await expect(async () => {
    await box.fill('has no "entries": needs Storybook 7 or later');
    await expect(first).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(first).toHaveAttribute("href", /^\/docs\/troubleshooting#/);

  await first.click();
  await page.waitForURL("**/docs/troubleshooting#*");
  await expect(page.locator(page.url().slice(page.url().indexOf("#")))).toBeVisible();

  const foreign = requests.filter((url) => new URL(url).origin !== origin);
  expect(foreign).toEqual([]);
  const index = requests.filter((url) => url.endsWith("/search-index.json"));
  expect(index.length).toBeGreaterThan(0);
});

test("a search for nothing says so", async ({ page }) => {
  await page.goto("/docs/install", { waitUntil: "networkidle" });
  await openRail(page);
  const status = page.getByTestId("docs-search-status");
  await expect(async () => {
    await page.getByTestId("docs-search").fill("zzzqqqxxx");
    await expect(status).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(status).toContainText("Nothing matches");
});
