import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/*
 * Home's own tokens in each scheme, and the motion a visitor can opt out of. Each runs on a desktop
 * and a phone (playwright.config.ts). The scheme itself, over the load and the toggle, is
 * header.spec.ts.
 */

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: every --home- token has a value`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/", { waitUntil: "networkidle" });
    const css = await readFile(join(import.meta.dirname, "../src/home.css"), "utf8");
    const names = [...new Set(css.match(/--home-[a-z0-9-]+/g))];
    expect(names.length).toBeGreaterThan(10);
    const empty = await page.evaluate(
      (list) =>
        list.filter(
          (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() === "",
        ),
      names,
    );
    expect(empty).toEqual([]);
  });
}

test("nothing moves under reduced motion, and it moves otherwise", async ({ page }) => {
  const moving = () =>
    page.evaluate(
      () => document.getAnimations().filter((one) => one instanceof CSSAnimation).length,
    );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "networkidle" });
  expect(await moving()).toBe(0);
  // Everything is on the page already, scrolled to or not.
  const hidden = await page.evaluate(
    () =>
      [...document.querySelectorAll(".home-reveal")].filter((one) => {
        const style = getComputedStyle(one);
        return style.opacity !== "1" || style.translate !== "none";
      }).length,
  );
  expect(hidden).toBe(0);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload({ waitUntil: "networkidle" });
  expect(await moving()).toBeGreaterThan(0);
});

/*
 * On a phone the read-out pill once hung over the demo window's bottom edge and covered its Branch and
 * Main chips (PS-313). At 390 its box meets no other visible element in the hero: not the window, the
 * chips or the caption. The hero's backdrop (aurora, grid) lies under everything and is not counted.
 */
test("at 390 the read-out pill overlaps nothing else in the hero", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the phone project only");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const hits = await page.evaluate(() => {
    const readout = document.querySelector(".home-readout");
    const hero = readout?.closest("section");
    if (!readout || !hero) return ["no read-out in a hero section"];
    const pill = readout.getBoundingClientRect();
    const meets = (other: DOMRect): boolean =>
      other.width > 0 &&
      other.height > 0 &&
      other.left < pill.right &&
      other.right > pill.left &&
      other.top < pill.bottom &&
      other.bottom > pill.top;
    const found = [...hero.querySelectorAll("*")]
      .filter((element) => !readout.contains(element) && !element.contains(readout))
      .filter((element) => !element.closest(".home-aurora, .home-grid"))
      .filter((element) => element.checkVisibility({ visibilityProperty: true }))
      .filter((element) => meets(element.getBoundingClientRect()))
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return found;
  });
  expect(hits).toEqual([]);
});
