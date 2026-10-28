import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { PAGES } from "../src/content/pages.ts";

/*
 * Every page, on a desktop and a phone: the nav and the footer are there, every internal link and
 * anchor lands on something, nothing links to the repository or the hosted app while both are
 * closed, and nothing scrolls sideways. That the docs and compare pages agree with their source
 * files is checked in the unit tests (src/content/docs.test.tsx, matrix.test.tsx).
 */

const CLOSED = ["github.com/madangryscientist", "ghcr.io/madangryscientist", "app.pixelslash.dev"];

async function hrefs(page: Page): Promise<string[]> {
  return page
    .locator("a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
}

async function idsOn(page: Page, path: string): Promise<Set<string>> {
  const html = await (await page.request.get(path)).text();
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""));
}

for (const { to, label } of PAGES) {
  test(`${label} (${to}): nav, footer, links`, async ({ page }, info) => {
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
    await expect(footer.getByTestId("source-status")).toHaveText("Source opens at launch");

    const known = new Set<string>(PAGES.map((item) => item.to));
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
      const name = to === "/" ? "home" : to.slice(1);
      await page.screenshot({
        path: join(dir, `${name}-${info.project.name}.png`),
        fullPage: true,
      });
    }
  });
}
