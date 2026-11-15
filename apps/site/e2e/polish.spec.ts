import { expect, test } from "@playwright/test";
import { DOC_PAGES } from "../src/content/docs-map.ts";
import { PAGES } from "../src/content/pages.ts";
import { textBelowAA, worstOverArt } from "./support/contrast.ts";

/*
 * The polish (PS-312): text that passes AA in both themes, copy buttons that copy, and one ground
 * under every page. The home's own checks left with it for slashslash.build.
 */

const PATHS = [
  ...new Set([...PAGES.map((page) => page.to), ...DOC_PAGES.map((page) => `/docs/${page.slug}`)]),
];

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: no text on any page falls under WCAG AA`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const path of PATHS) {
      await page.goto(path, { waitUntil: "networkidle" });
      const found = await textBelowAA(page);
      expect(found, `${scheme} ${path}`).toEqual([]);
    }
  });
}

// One test per path, each on its own budget, so the check does not grow with the page count (PS-382).
for (const path of PATHS) {
  test(`${path}: every copy button copies its block`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(path, { waitUntil: "networkidle" });
    // By position, not by name: a copied button is named "copied" and would drop out of a name match.
    const all = page.locator("figure:has(pre) button");
    const count = await all.count();
    for (let index = 0; index < count; index += 1) {
      const button = all.nth(index);
      await button.scrollIntoViewIfNeeded();
      const block = button.locator("xpath=ancestor::figure[1]");
      await button.click();
      await expect(button, `${path} #${index}`).toHaveText("copied");
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      const shown = (await block.locator("pre").first().innerText()).replace(/\s+/g, " ").trim();
      expect(copied.replace(/\s+/g, " ").trim(), `${path} #${index}`).toBe(shown);
    }
  });
}

test("the site carries more than 20 copy buttons in total", async ({ context }) => {
  // Counted without clicking, a page at a time in parallel, so it stays well inside the default budget.
  const counts = await Promise.all(
    PATHS.map(async (path) => {
      const tab = await context.newPage();
      await tab.goto(path, { waitUntil: "networkidle" });
      const count = await tab.locator("figure:has(pre) button").count();
      await tab.close();
      return count;
    }),
  );
  expect(counts.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(20);
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: every page stands on the same ground`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const ground = async (path: string): Promise<string> => {
      await page.goto(path, { waitUntil: "networkidle" });
      return page.locator("[data-art]").evaluate((el) => getComputedStyle(el).backgroundColor);
    };
    const docs = await ground("/docs");
    for (const path of ["/docs/cli", "/self-host", "/security"])
      expect(await ground(path), path).toBe(docs);
    await page.goto("/security", { waitUntil: "networkidle" });
    await expect(page.locator(".page-art-bg .home-aurora")).toHaveCount(1);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: heading text on an inner page holds AA over the aurora, pixel by pixel`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const path of ["/self-host", "/docs", "/security"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      // The h1 is large text (3); the first paragraph under it needs 4.5.
      const [h1] = await worstOverArt(page, "main h1");
      expect(h1, `${path} h1`).toBeGreaterThanOrEqual(3);
      await page.goto(path, { waitUntil: "networkidle" });
      const [lead] = await worstOverArt(page, "main p");
      expect(lead, `${path} lead`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
