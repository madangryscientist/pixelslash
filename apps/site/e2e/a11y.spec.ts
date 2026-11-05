import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { DOC_PAGES } from "../src/content/docs-map.ts";
import { PAGES } from "../src/content/pages.ts";

/* axe, every rule it runs, on every page of the site, in both themes, at both widths. */

const PATHS = [...PAGES.map((page) => page.to), ...DOC_PAGES.map((page) => `/docs/${page.slug}`)];

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: axe finds nothing on any page`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const path of PATHS) {
      await page.goto(path, { waitUntil: "networkidle" });
      const { violations } = await new AxeBuilder({ page }).analyze();
      const found = violations.map(
        (item) => `${item.id}: ${item.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      );
      expect(found, `${scheme} ${path}`).toEqual([]);
    }
  });
}

test("a code block too wide for its box takes keyboard focus, and one that fits does not", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const scrollers = page.locator('main [class*="overflow-x-auto"]:not(:has(a[href], button))');
  expect(await scrollers.count()).toBeGreaterThan(0);
  for (const scroller of await scrollers.all()) {
    const overflows = await scroller.evaluate((node) => node.scrollWidth > node.clientWidth);
    if (overflows) await expect(scroller).toHaveAttribute("tabindex", "0");
    else await expect(scroller).not.toHaveAttribute("tabindex");
  }
});
