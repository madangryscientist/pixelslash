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
