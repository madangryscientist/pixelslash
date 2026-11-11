import { expect, test } from "@playwright/test";
import { GROUPS, LISTED_PAGES } from "../src/content/docs-map.ts";
import { groupRows } from "./support/docs-rows.ts";

/*
 * PS-378: the /docs landing has a hierarchy. A group heading is larger and heavier than the links
 * under it, Get started is the first group, spans the row and starts above the fold, a long group
 * (more than 8 links) spans the row in two columns, no group sits alone in a half row, the cards in
 * a row end level (PS-385), the chevrons take the accent ink, and the intro is held to 75ch. That every listed page is
 * still linked stays with smoke.spec.ts and docs.test.tsx. Desktop, 1440x900, both themes.
 */

for (const scheme of ["light", "dark"] as const) {
  test.describe(`the landing hierarchy at 1440 in ${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    test.skip(({ isMobile }) => isMobile, "the desktop project only");

    // PS-378: a group heading is stronger than the links under it, measured, not assumed.
    test("each group heading is larger than every link in its card", async ({ page }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const cards = page.getByTestId("docs-index").locator(":scope > li");
      for (const [index, group] of GROUPS.entries()) {
        const card = cards.nth(index);
        const heading = await card.locator("h2").evaluate((el) => {
          const style = getComputedStyle(el);
          return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) };
        });
        const links = await card
          .locator("a[href^='/docs/']")
          .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
        expect(links.length, `${group.id}: has links`).toBeGreaterThan(0);
        for (const size of links)
          expect(heading.size, `${group.id}: heading against a link`).toBeGreaterThan(size);
        expect(heading.weight, `${group.id}: heading weight`).toBeGreaterThanOrEqual(600);
      }
    });

    test("Get started is the first group, spans the row and starts above the fold", async ({
      page,
    }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const cards = page.getByTestId("docs-index").locator(":scope > li");
      await expect(cards.first().locator("h2")).toHaveText(GROUPS[0].title);
      const heading = await cards.first().locator("h2").boundingBox();
      if (!heading) throw new Error("the Get started heading has no box");
      expect(heading.y, "heading top is above the fold").toBeLessThan(900);
      // It spans both columns: as wide as the list, and wider than a later, two-up group.
      const [list, first, second] = await Promise.all([
        page.getByTestId("docs-index").boundingBox(),
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
      ]);
      if (!list || !first || !second) throw new Error("a group has no box");
      expect(first.width).toBeGreaterThanOrEqual(list.width - 1);
      expect(second.width).toBeLessThan(list.width * 0.6);
    });

    layoutTests();

    test("the intro is held to 75ch", async ({ page }) => {
      await page.goto("/docs", { waitUntil: "networkidle" });
      const intro = page.getByTestId("docs-intro");
      const [width, ch75] = await intro.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:75ch;visibility:hidden";
        el.append(probe);
        const measured = probe.getBoundingClientRect().width;
        probe.remove();
        return [el.getBoundingClientRect().width, measured];
      });
      expect(width, "intro width against 75ch").toBeLessThanOrEqual(ch75 + 1);
    });
  });
}

/** PS-385: the grid's row rules, run inside the 1440 describes above (viewport and scheme are theirs). */
function layoutTests(): void {
  test("every group with more than 8 listed links is full width, in two columns", async ({
    page,
  }) => {
    await page.goto("/docs", { waitUntil: "networkidle" });
    const cards = page.getByTestId("docs-index").locator(":scope > li");
    const list = await page.getByTestId("docs-index").boundingBox();
    if (!list) throw new Error("the list has no box");
    let longGroups = 0;
    for (const [index, group] of GROUPS.entries()) {
      const count = LISTED_PAGES.filter((p) => p.group === group.id).length;
      const box = await cards.nth(index).boundingBox();
      if (!box) throw new Error(`${group.id} has no box`);
      if (count <= 8) continue;
      longGroups += 1;
      expect(box.width, `${group.id}: ${count} links span the row`).toBeGreaterThanOrEqual(
        list.width - 1,
      );
      const links = await cards
        .nth(index)
        .locator("a[href^='/docs/']")
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(links).size, `${group.id}: links in two columns`).toBe(2);
    }
    expect(longGroups, "the data has a long group").toBeGreaterThan(0);
  });

  test("every group is full width or shares its row with exactly one half width group", async ({
    page,
  }) => {
    await page.goto("/docs", { waitUntil: "networkidle" });
    const list = await page.getByTestId("docs-index").boundingBox();
    if (!list) throw new Error("the list has no box");
    const full = (width: number): boolean => width >= list.width - 1;
    for (const row of await groupRows(page)) {
      if (row.groups.length === 1)
        expect(
          full(row.groups[0]?.width ?? 0),
          `row at ${Math.round(row.top)}: alone, so full`,
        ).toBe(true);
      else {
        expect(row.groups, `row at ${Math.round(row.top)}: shares with exactly one`).toHaveLength(
          2,
        );
        expect(
          row.groups.every((g) => !full(g.width)),
          "both are half width",
        ).toBe(true);
      }
    }
  });

  test("cards in one row end level", async ({ page }) => {
    await page.goto("/docs", { waitUntil: "networkidle" });
    const rows = await groupRows(page);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const bottoms = row.groups.map((g) => g.bottom);
      const spread = Math.max(...bottoms) - Math.min(...bottoms);
      expect(spread, `row at ${Math.round(row.top)}: card bottoms`).toBeLessThanOrEqual(2);
    }
  });
  chevronTest();
}

/** PS-385: the chevron after each link is accent ink, the link text stays quiet. */
function chevronTest(): void {
  test("the chevrons take the accent ink, the link text stays quiet", async ({ page }) => {
    await page.goto("/docs", { waitUntil: "networkidle" });
    const colours = await page.getByTestId("docs-index").evaluate((list) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--hc-accent)";
      list.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const link = list.querySelector("ul a[href^='/docs/']");
      const chevron = link?.querySelector("svg");
      if (!link || !chevron) throw new Error("no index link with a chevron");
      return {
        accent,
        text: getComputedStyle(link).color,
        chevron: getComputedStyle(chevron).color,
      };
    });
    expect(colours.chevron, "chevron against the accent token").toBe(colours.accent);
    expect(colours.chevron, "chevron against the link text").not.toBe(colours.text);
  });
}
