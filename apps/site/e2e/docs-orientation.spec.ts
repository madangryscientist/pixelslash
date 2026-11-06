import { type Page, expect, test } from "@playwright/test";
import { DOC_PAGES } from "../src/content/docs-map.ts";

/*
 * Where a reader is in the docs: the rail with the current page marked and only its group open,
 * breadcrumbs, a contents list that follows the headings, an index with one first step, and a phone
 * that folds the rail and the contents. Each runs on a desktop and a phone (playwright.config.ts).
 * PS-333 adds the sticky rail and contents: the kit's `SidebarLayout` and `DetailLayout stickyAside`.
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

/** The bottom edge of the sticky header, which nothing sticky may slide under. */
const headerBottom = (page: Page): Promise<number> =>
  page
    .locator("header")
    .first()
    .evaluate((header) => header.getBoundingClientRect().bottom);

for (const scheme of ["light", "dark"] as const) {
  test(`1440x900, ${scheme}: the rail and the contents stay in view halfway down a long page`, async ({
    page,
  }, info) => {
    test.skip(isPhone(info), "the sticky columns are a desktop view");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    // The longest page: the most headings, so the longest article.
    await page.goto("/docs/troubleshooting", { waitUntil: "networkidle" });
    const nav = page.getByTestId("docs-nav");
    const contents = page.getByTestId("docs-contents");
    await expect(nav).toBeInViewport();
    await expect(contents).toBeInViewport();

    const scrolled = await page.evaluate(() => {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, room / 2);
      return window.scrollY;
    });
    // Long enough to mean something: the page really moved a long way.
    expect(scrolled).toBeGreaterThan(900);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(900);

    const header = await headerBottom(page);
    // A column taller than the room scrolls itself, so it may be cut at the bottom; its top is what stays.
    for (const column of [nav, contents]) {
      await expect(column).toBeInViewport();
      await expect(column.locator("a").first()).toBeInViewport({ ratio: 1 });
      const box = await column.boundingBox();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(header - 0.5);
    }
  });
}

test("a rail taller than the viewport scrolls inside itself, under the header", async ({
  page,
}, info) => {
  test.skip(isPhone(info), "the sticky columns are a desktop view");
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const nav = page.getByTestId("docs-nav");
  // Open the last group: its last link is the rail's end, and it is not in view yet.
  const last = page.getByTestId("docs-group-help");
  await expect(async () => {
    await last.getByRole("button").click();
    await expect(last.locator("a").last()).toBeAttached();
    await expect(last.locator("a").last()).toBeVisible({ timeout: 1000 });
  }).toPass();
  const end = last.locator("a").last();

  // The rail's own scroller: the nearest ancestor that scrolls vertically, marked so a locator can reach it.
  const found = await nav.evaluate((node) => {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        el.setAttribute("data-rail-scroller", "");
        return true;
      }
    }
    return false;
  });
  expect(found, "the rail has an element that scrolls").toBe(true);
  const scroller = page.locator("[data-rail-scroller]");
  const overflows = await scroller.evaluate((node) => node.scrollHeight > node.clientHeight);
  expect(overflows).toBe(true);
  await expect(end).not.toBeInViewport();

  await scroller.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expect(end).toBeInViewport({ ratio: 1 });
  // The page did not move to make room, and the rail still sits below the header.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const header = await headerBottom(page);
  const top = await scroller.evaluate((node) => node.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(header - 0.5);
});

test("390 wide: no docs page scrolls sideways, and the fold opens to reach the rail and the contents", async ({
  page,
}, info) => {
  test.skip(!isPhone(info), "the phone view");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/docs", "/self-host", ...DOC_PAGES.map((doc) => `/docs/${doc.slug}`)]) {
    await page.goto(path, { waitUntil: "load" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
  }

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await expect(page.getByTestId("docs-contents")).toBeHidden();
  const fold = page.locator("summary", { hasText: /^On this page$/ });
  await fold.click();
  const link = page.locator("details", { hasText: "On this page" }).locator("a").first();
  await expect(link).toBeVisible();
  await openRail(page);
  await expect(page.getByTestId("docs-nav").locator('a[href="/docs/upload"]')).toBeVisible();
});
