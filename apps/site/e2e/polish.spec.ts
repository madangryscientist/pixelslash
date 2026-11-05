import { expect, test } from "@playwright/test";
import { DOC_PAGES } from "../src/content/docs-map.ts";
import { PAGES } from "../src/content/pages.ts";
import { textBelowAA, worstOverArt } from "./support/contrast.ts";

/*
 * The home polish (PS-312): text that passes AA in both themes, copy buttons that copy, no dead zone
 * under the demo, the hackcove icons in place of local glyphs, and one ground from the home to every
 * other page.
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

test('home: "Read more" clears 7:1 in both themes', async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    // The lifted link: 4.5 plus 2.5 of margin.
    const low = (await textBelowAA(page, 2.5)).filter((item) =>
      item.text.startsWith("Read more →"),
    );
    expect(low, scheme).toEqual([]);
  }
});

test("every copy button on the site copies its block", async ({ page, context }) => {
  test.slow();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let buttons = 0;
  for (const path of PATHS) {
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
      buttons += 1;
    }
  }
  expect(buttons).toBeGreaterThan(20);
  // The pages that carry their own blocks have one.
  for (const path of ["/", "/how-it-works"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "copy", exact: true })).not.toHaveCount(0);
  }
});

test("home: no dead zone under the demo", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the desktop width is the one asked for");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    const demo = await page.locator("figure.home-demo-wrap").boundingBox();
    const next = await page.locator(".home-step").first().boundingBox();
    if (!demo || !next) throw new Error("home has no demo or steps");
    const gap = next.y - (demo.y + demo.height);
    expect(gap, `${scheme}: gap between the demo's caption and the steps, px`).toBeLessThan(130);
    // Between the sections that follow: the step's text to the next heading.
    const steps = await page.locator(".home-steps").boundingBox();
    const heading = await page.getByRole("heading", { name: "What it does" }).boundingBox();
    if (!steps || !heading) throw new Error("home has no steps or features");
    expect(heading.y - (steps.y + steps.height), `${scheme}: steps to features, px`).toBeLessThan(
      130,
    );
  }
});

test("home: the feature cards carry the library's icons", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".home-cards svg")).toHaveCount(6);
  await page.goto("/pricing", { waitUntil: "networkidle" });
  await expect(page.getByTestId("pricing-facts").locator("svg")).toHaveCount(3);
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: an inner page stands on the home's ground`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const ground = async (path: string): Promise<string> => {
      await page.goto(path, { waitUntil: "networkidle" });
      return page.locator("[data-art]").evaluate((el) => getComputedStyle(el).backgroundColor);
    };
    const home = await ground("/");
    for (const path of ["/pricing", "/how-it-works", "/docs", "/security"])
      expect(await ground(path), path).toBe(home);
    await page.goto("/pricing", { waitUntil: "networkidle" });
    await expect(page.locator(".page-art-bg .home-aurora")).toHaveCount(1);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: heading text on an inner page holds AA over the aurora, pixel by pixel`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const path of ["/how-it-works", "/pricing", "/docs", "/security"]) {
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
