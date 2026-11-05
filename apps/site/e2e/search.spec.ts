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

test("the index is a static file, and a search for nothing says so", async ({ page }) => {
  const reply = await page.request.get("/search-index.json");
  expect(reply.status()).toBe(200);
  const entries: { url: string; text: string }[] = await reply.json();
  expect(entries.length).toBeGreaterThan(100);
  expect(entries.some((entry) => entry.url.startsWith("/self-host"))).toBe(true);

  await page.goto("/docs/install", { waitUntil: "networkidle" });
  await openRail(page);
  const status = page.getByTestId("docs-search-status");
  await expect(async () => {
    await page.getByTestId("docs-search").fill("zzzqqqxxx");
    await expect(status).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(status).toContainText("Nothing matches");
});

test("self-host is in the docs rail, and a code block has a copy button and an edit link", async ({
  page,
}) => {
  await page.goto("/docs/install");
  await openRail(page);
  await expect(page.getByTestId("docs-nav").locator('a[href="/self-host"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "copy" }).first()).toBeVisible();
  await expect(page.getByTestId("docs-edit").locator("a")).toHaveAttribute(
    "href",
    /github\.com\/.+\/edit\/main\/docs\//,
  );

  await page.goto("/self-host");
  await openRail(page);
  await expect(page.getByTestId("docs-nav")).toBeVisible();
});
