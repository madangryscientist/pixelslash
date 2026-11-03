import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { DOC_PAGES, neighbours } from "../src/content/docs-map.ts";
import { PAGES } from "../src/content/pages.ts";

/*
 * Every page, on a desktop and a phone: the nav and the footer are there, every internal link and
 * anchor lands on something, nothing links to the hosted app while it is closed, and nothing scrolls sideways. That the docs and compare pages agree with their source
 * files is checked in the unit tests (src/content/docs.test.tsx, matrix.test.tsx).
 */

const CLOSED = ["app.pixelslash.dev"];

async function hrefs(page: Page): Promise<string[]> {
  return page
    .locator("a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
}

async function idsOn(page: Page, path: string): Promise<Set<string>> {
  const html = await (await page.request.get(path)).text();
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""));
}

const DOC_PATHS = DOC_PAGES.map((item) => `/docs/${item.slug}`);

/** The nav, footer, links, anchors and width checks every page of the site passes. */
async function checkPage(
  page: Page,
  to: string,
  info: { project: { name: string } },
): Promise<void> {
  {
    const response = await page.goto(to);
    expect(response?.status()).toBe(200);

    const nav = page.getByTestId("site-nav");
    for (const item of PAGES)
      await expect(nav.getByRole("link", { name: item.label, exact: true })).toHaveCount(1);

    const footer = page.getByTestId("footer");
    await expect(footer.getByTestId("trademark")).toContainText("PixelSlash is a name of");
    await expect(footer.getByRole("link", { name: "hello@hack-cove.com" })).toHaveAttribute(
      "href",
      "mailto:hello@hack-cove.com",
    );
    await expect(footer.getByTestId("source-status")).toHaveText("GitHub");
    await expect(footer.getByTestId("source-status")).toHaveAttribute(
      "href",
      "https://github.com/madangryscientist/pixelslash",
    );

    const known = new Set<string>([...PAGES.map((item) => item.to), ...DOC_PATHS]);
    for (const href of await hrefs(page)) {
      expect(
        CLOSED.some((closed) => href.includes(closed)),
        `${href} leads somewhere closed`,
      ).toBe(false);
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path = "", anchor] = href.split("#");
      const target = path === "" ? to : path;
      expect(known.has(target), `${href} is not a page of the site`).toBe(true);
      if (anchor)
        expect((await idsOn(page, target)).has(anchor), `${href}: no #${anchor} on ${target}`).toBe(
          true,
        );
    }

    const width = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(width, "the page scrolls sideways").toBe(0);

    const dir = process.env["SITE_SHOTS_DIR"];
    if (dir) {
      const name = to === "/" ? "home" : to.slice(1).replaceAll("/", "-");
      // Still, and with every scroll reveal shown: a full-page shot does not scroll the page.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.screenshot({
        path: join(dir, `${name}-${info.project.name}.png`),
        fullPage: true,
      });
    }
  }
}

for (const { to, label } of PAGES) {
  test(`${label} (${to}): nav, footer, links`, async ({ page }, info) => {
    await checkPage(page, to, info);
  });
}

test("/docs is the index: a card per group, every page linked, the rail marks All docs", async ({
  page,
}, info) => {
  await checkPage(page, "/docs", info);
  const index = page.getByTestId("docs-index");
  for (const item of DOC_PAGES)
    await expect(index.locator(`a[href="/docs/${item.slug}"]`)).toHaveCount(1);
  await expect(page.getByTestId("docs-nav").locator('a[href="/docs"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

for (const doc of DOC_PAGES) {
  test(`/docs/${doc.slug}: group nav, on this page, previous and next`, async ({ page }, info) => {
    await checkPage(page, `/docs/${doc.slug}`, info);
    const nav = page.getByTestId("docs-nav");
    for (const other of DOC_PAGES)
      await expect(nav.locator(`a[href="/docs/${other.slug}"]`)).toHaveCount(1);
    await expect(nav.locator(`a[href="/docs/${doc.slug}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );

    const { prev, next } = neighbours(doc.slug);
    if (prev)
      await expect(page.getByTestId("docs-prev").locator("a")).toHaveAttribute(
        "href",
        `/docs/${prev.slug}`,
      );
    if (next)
      await expect(page.getByTestId("docs-next").locator("a")).toHaveAttribute(
        "href",
        `/docs/${next.slug}`,
      );

    // The rail is the desktop view; a phone gets the fold above the page.
    const contents = info.project.name.includes("mobile")
      ? page.locator("details", { hasText: "On this page" })
      : page.getByTestId("docs-contents");
    if ((await contents.count()) > 0) await expect(contents.first()).toBeVisible();
  });
}

test("an old /docs#anchor lands on the page that holds it, scrolled to the heading", async ({
  page,
}) => {
  await page.goto("/docs#uploading-to-a-server");
  await page.waitForURL("**/docs/upload#uploading-to-a-server");
  await expect(page.locator("#uploading-to-a-server")).toBeInViewport();
});

test("an unknown docs page is a 404", async ({ page }) => {
  const response = await page.goto("/docs/no-such-page");
  expect(response?.status()).toBe(404);
});
