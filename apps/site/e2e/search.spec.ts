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

/*
 * The search glass and the / shortcut. The box is the one on screen: the landing's content column,
 * or the rail on a docs page (folded on a phone, where the key does nothing).
 */

test("the search field has a decorative glass, and the hint names the key", async ({ page }) => {
  await page.goto("/docs", { waitUntil: "networkidle" });
  const field = page.getByTestId("docs-search");
  // The kit's Icon is decorative on its wrapper (aria-hidden), and draws the glass inside it.
  const glassBox = page.getByRole("search").locator("[aria-hidden='true']:has(> svg)").first();
  await expect(glassBox).toBeVisible();
  await expect(glassBox.locator("svg")).toBeVisible();
  await expect(field).toHaveAccessibleName("Search the docs");
  await expect(field).toHaveAttribute("placeholder", "Search the docs (press /)");
});

/** Press `/` until the field takes focus: the listener is attached after hydration, so a first press can land early. */
async function slashFocuses(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
  const field = page.getByTestId("docs-search");
  await expect(async () => {
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("/");
    await expect(field, path).toBeFocused({ timeout: 1000 });
  }).toPass();
  await expect(field, path).toHaveValue("");
}

test("/ focuses the search field from anywhere on /docs, and on a docs page's rail", async ({
  page,
  isMobile,
}) => {
  await slashFocuses(page, "/docs");
  // On a phone the rail is folded, so the key focuses nothing there (the desktop run checks the rail).
  if (!isMobile) await slashFocuses(page, "/docs/install");
});

test("/ types into a text field, and Ctrl, Alt or Meta with it does nothing", async ({ page }) => {
  await slashFocuses(page, "/docs");
  const field = page.getByTestId("docs-search");
  await field.click();
  await page.keyboard.press("/");
  await expect(field).toHaveValue("/");

  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Control+/");
  await page.keyboard.press("Alt+/");
  await page.keyboard.press("Meta+/");
  await expect(field).not.toBeFocused();
});
