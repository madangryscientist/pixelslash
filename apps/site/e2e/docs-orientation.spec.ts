import { type Page, expect, test } from "@playwright/test";

/*
 * Where a reader is in the docs: the rail with the current page marked and only its group open,
 * breadcrumbs, a contents list that follows the headings, an index with one first step, and a phone
 * that folds the rail and the contents. Each runs on a desktop and a phone (playwright.config.ts).
 */

// A page long enough to have several headings and a group other than the first.
const PAGE = "/docs/upload";
const GROUP = "docs-group-review";
const OTHER_GROUP = "docs-group-tutorials";

const isPhone = (info: { project: { name: string } }): boolean => info.project.name === "mobile";

/** On a phone the rail is folded under a "Docs" summary: open it, as a reader would. */
async function openRail(page: Page): Promise<void> {
  const fold = page.locator("summary", { hasText: /^Docs$/ });
  if (await fold.isVisible()) await fold.click();
}

test("the rail marks the page and opens only its own group", async ({ page }) => {
  await page.goto(PAGE, { waitUntil: "networkidle" });
  await openRail(page);
  const nav = page.getByTestId("docs-nav");
  await expect(nav.locator('a[href="/docs/upload"]')).toHaveAttribute("aria-current", "page");
  await expect(nav.locator('a[href="/docs/upload"]')).toBeVisible();
  // Another group is folded: its pages are in the page for a search or a find, but not shown.
  const other = page.getByTestId(OTHER_GROUP);
  await expect(other.locator('a[href="/docs/tutorial-storybook"]')).toBeHidden();

  // A reader opens it, as a click on its name.
  await expect(async () => {
    await other.getByRole("button").click();
    await expect(other.locator('a[href="/docs/tutorial-storybook"]')).toBeVisible({
      timeout: 1000,
    });
  }).toPass();
  await expect(page.getByTestId(GROUP).locator('a[href="/docs/upload"]')).toBeVisible();
});

test("the breadcrumbs name the group and the page, and Docs leads back to the index", async ({
  page,
}) => {
  await page.goto(PAGE);
  const crumbs = page.getByRole("navigation", { name: /breadcrumb/i });
  await expect(crumbs).toContainText("Docs");
  await expect(crumbs).toContainText("Review server and CI");
  await expect(crumbs).toContainText("Upload to a server");
  await expect(crumbs.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
});

test("the contents follow the headings: the one being read is marked", async ({ page }, info) => {
  test.skip(isPhone(info), "the contents column is a desktop view; a phone gets the fold below");
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const contents = page.getByTestId("docs-contents");
  const marked = contents.locator('a[aria-current="location"]');
  await expect(contents.locator("a").first()).toBeVisible();
  // Before any scrolling, the page's first heading.
  await expect(marked).toHaveCount(1);
  const first = await contents.locator("a").first().getAttribute("href");
  await expect(marked).toHaveAttribute("href", first ?? "");

  const links = await contents
    .locator("a")
    .evaluateAll((all) => all.map((link) => link.getAttribute("href") ?? ""));
  const target = links[Math.floor(links.length / 2)] ?? "";
  expect(target).not.toBe(first);
  await page.evaluate((hash) => {
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, target);
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAttribute("href", target);

  // And it is a link: following it lands on its heading.
  await contents.locator(`a[href="${first}"]`).click();
  await expect(marked).toHaveAttribute("href", first ?? "");
});

test("on a phone the rail and the contents are folded, and every page is still reachable", async ({
  page,
}, info) => {
  test.skip(!isPhone(info), "the phone view");
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const rail = page.locator("details", { has: page.getByTestId("docs-nav") });
  const contents = page.locator("details", { hasText: "On this page" });
  await expect(rail).not.toHaveAttribute("open", "");
  await expect(contents.first()).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("docs-nav")).toBeHidden();
  await expect(page.getByTestId("docs-contents")).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Open the rail and a group, and go to a page in it.
  await openRail(page);
  const group = page.getByTestId("docs-group-capture");
  await expect(async () => {
    await group.getByRole("button").click();
    await expect(group.locator('a[href="/docs/capture"]')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await group.locator('a[href="/docs/capture"]').click();
  await page.waitForURL(/\/docs\/capture\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the index names one first step, and it works", async ({ page }) => {
  await page.goto("/docs", { waitUntil: "networkidle" });
  const step = page.getByTestId("docs-first-step");
  await expect(step).toHaveCount(1);
  await expect(step).toBeVisible();
  await expect(step).toHaveAttribute("href", "/docs/getting-started");
  await step.click();
  await page.waitForURL(/\/docs\/getting-started\/?$/);
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
});
