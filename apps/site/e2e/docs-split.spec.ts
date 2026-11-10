import { type Page, expect, test } from "@playwright/test";

/*
 * PS-357: each docs page loads only its own text. The index carries no page's body, and a page's
 * body is its own chunk, loaded while the page hydrates; a page cut from docs/cli.md carries its
 * own cut, not the file. The headings, rail, contents list, search box and previous and next links
 * of every page are smoke.spec.ts's, docs-orientation.spec.ts's and search.spec.ts's; this adds
 * what the split could break: what each page loads, and hydration with no error.
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

/** The text of every script the page runs, gathered as it loads. */
function scriptsOf(page: Page): () => Promise<string> {
  const texts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") texts.push(response.text());
  });
  return async () => (await Promise.all(texts)).join("\n");
}

/** A sentence from deep in docs/cli.md (the signing-in page) and one from getting-started.md. */
const SIGNING_IN = "The first line is one plain line to grep for";
const GETTING_STARTED = "comparing PNGs needs no browser";

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
  const scripts = scriptsOf(page);
  await page.goto("/docs", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Docs" })).toBeVisible();
  await expect(page.getByText("compares two versions of a page").first()).toBeVisible();
  await expect(page.getByTestId("docs-index").locator("a").first()).toBeVisible();
  await searchWorks(page);
  const code = await scripts();
  expect(code.includes("compares two versions of a page"), "the index's own lead").toBe(true);
  expect(code.includes(SIGNING_IN), "cli.md's body").toBe(false);
  expect(code.includes(GETTING_STARTED), "getting-started.md's body").toBe(false);
  expect(errors).toEqual([]);
});

test("a page cut from cli.md loads its own cut, not the file", async ({ page }) => {
  const errors = errorsOf(page);
  const scripts = scriptsOf(page);
  await page.goto("/docs/install", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Install" })).toBeVisible();
  await expect(page.getByText("fetch a browser once").first()).toBeVisible();
  const code = await scripts();
  expect(code.includes("fetch a browser once"), "the page's own text").toBe(true);
  expect(code.includes(SIGNING_IN), "another cli page's text").toBe(false);
  expect(code.includes(GETTING_STARTED), "getting-started.md's body").toBe(false);
  expect(errors).toEqual([]);
});

test("a page hydrates with its text, and following next loads that page's", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto("/docs/getting-started", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  await searchWorks(page);
  const next = page.getByTestId("docs-next").locator("a");
  const href = (await next.getAttribute("href")) ?? "";
  await next.click();
  await page.waitForURL(`**${href}`);
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Getting started");
  await expect(page.locator("[data-doc]").locator("p").first()).toBeVisible();
  expect(errors).toEqual([]);
});
