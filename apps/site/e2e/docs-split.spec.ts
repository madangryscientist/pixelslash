import { type Page, expect, test } from "@playwright/test";

/*
 * PS-357: each docs page loads only its own text. The index carries no page's body, and a page's
 * body is its own chunk, loaded while the page hydrates. What the reader sees is the same as when
 * every page's text shipped with every page: the headings, the rail, the contents list, the search
 * box and the previous and next links, before and after hydration, with no hydration error.
 */

/** On a phone the rail is folded under a "Docs" summary: open it, as a reader would. */
async function openRail(page: Page): Promise<void> {
  const fold = page.locator("summary", { hasText: /^Docs$/ });
  if (await fold.isVisible()) await fold.click();
}

/** Errors the page logs, a hydration mismatch among them. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The search box works only once the page has hydrated: a query shows results. */
async function searchWorks(page: Page): Promise<void> {
  await openRail(page);
  const box = page.getByTestId("docs-search");
  await expect(box).toBeVisible();
  const first = page.getByTestId("docs-search-results").locator("a").first();
  await expect(async () => {
    await box.fill("exit code");
    await expect(first).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test("the index: its lead, every group and the search box, and no page's text is loaded", async ({
  page,
}) => {
  const errors = errorsOf(page);
  const scripts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scripts.push(response.text());
  });
  await page.goto("/docs", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Docs" })).toBeVisible();
  await expect(page.getByText("compares two versions of a page").first()).toBeVisible();
  await expect(page.getByTestId("docs-index").locator("a").first()).toBeVisible();
  await searchWorks(page);
  // A sentence from deep in docs/cli.md and one from getting-started.md: neither page's body is in a script the index ran.
  const code = (await Promise.all(scripts)).join("\n");
  expect(code.includes("compares two versions of a page"), "the index's own lead").toBe(true);
  expect(code.includes("The first line is one plain line to grep for"), "cli.md's body").toBe(
    false,
  );
  expect(code.includes("comparing PNGs needs no browser"), "getting-started.md's body").toBe(false);
  expect(errors).toEqual([]);
});

test("a page keeps its whole text through hydration: headings, contents, rail, previous and next", async ({
  page,
}) => {
  const errors = errorsOf(page);
  await page.goto("/docs/getting-started", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  for (const name of ["Install", "Compare two URLs", "Open the report", "The exit code"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("npm i -D @hackcove/pixelslash").first()).toBeVisible();
  const contents = page.locator('nav[aria-label="On this page"], details:has-text("On this page")');
  await expect(contents.locator('a[href="#compare-two-urls"]').first()).toBeAttached();
  await expect(page.getByTestId("docs-next")).toBeVisible();
  await searchWorks(page);
  expect(errors).toEqual([]);
});

test("following next loads that page's own text", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto("/docs/getting-started", { waitUntil: "networkidle" });
  const next = page.getByTestId("docs-next").locator("a");
  const href = (await next.getAttribute("href")) ?? "";
  expect(href).toMatch(/^\/docs\//);
  await next.click();
  await page.waitForURL(`**${href}`);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).not.toHaveText("Getting started");
  await expect(page.locator("[data-doc]").locator("p").first()).toBeVisible();
  await expect(page.getByTestId("docs-prev").locator("a")).toHaveAttribute(
    "href",
    "/docs/getting-started",
  );
  expect(errors).toEqual([]);
});
