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
 * The hero's lead is a short pitch (PS-350, PS-366): at most 2 lines at 1440x900 on the desktop project
 * and 6 at 390x844 on the phone project, in both schemes. The lines are the lead's rendered height over
 * its line-height, so the count is what a visitor sees, wrapped at the real font. The lead is the
 * paragraph right after the hero's h1. It says how the diff works, so it does not repeat the headline
 * ("see what" and "change did" are the headline's words, PS-366).
 */
for (const scheme of ["light", "dark"] as const)
  test(`${scheme}: the hero lead fits its line count`, async ({ page, isMobile }) => {
    const size = isMobile
      ? { width: 390, height: 844, max: 6 }
      : { width: 1440, height: 900, max: 2 };
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const lines = await page.locator("h1 + p").evaluate((lead) => {
      const { lineHeight } = getComputedStyle(lead);
      return lead.getBoundingClientRect().height / parseFloat(lineHeight);
    });
    expect(lines).toBeLessThanOrEqual(size.max);
    const text = await page.locator("h1 + p").innerText();
    expect(text.toLowerCase()).not.toContain("see what");
    expect(text.toLowerCase()).not.toContain("change did");
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
    const meets = (other: {
      width: number;
      height: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
    }): boolean =>
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
      // The demo frame clips the shot's stage on a phone (PS-372): what counts is the part that shows.
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const frame = element.closest(".home-demo")?.getBoundingClientRect();
        if (!frame || element.classList.contains("home-demo")) return meets(box);
        return meets({
          width: box.width,
          height: box.height,
          left: Math.max(box.left, frame.left),
          right: Math.min(box.right, frame.right),
          top: Math.max(box.top, frame.top),
          bottom: Math.min(box.bottom, frame.bottom),
        });
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return found;
  });
  expect(hits).toEqual([]);
});

/*
 * PS-372: on a phone the hero demo frames the part of the shot that holds the changes, not the whole
 * shot squeezed into 350px. At 390x844, in both schemes: the shot is drawn at a scale of at least 0.45
 * (rendered width over its natural 1280; the whole shot was 0.27), every change region's border box
 * lies inside the frame, no chip meets a region, and the page does not scroll sideways. At 1440 and
 * 1024 nothing changed: the frame is the shot's 16:9 and the shot fills it.
 */
for (const scheme of ["light", "dark"] as const)
  test(`${scheme}: the phone hero demo frames the changes`, async ({ page, isMobile }) => {
    test.skip(!isMobile, "the phone project only");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.evaluate(() => {
      const frame = document.querySelector(".home-demo");
      const image = document.querySelector<HTMLImageElement>(".home-demo img");
      if (!frame || !image) throw new Error("home has no demo");
      const frameBox = frame.getBoundingClientRect();
      const regions = [...frame.querySelectorAll(".home-region")].map((one) =>
        one.getBoundingClientRect(),
      );
      const chips = [...frame.querySelectorAll(".home-chip")].map((one) =>
        one.getBoundingClientRect(),
      );
      const outside = regions.filter(
        (one) =>
          one.left < frameBox.left - 0.5 ||
          one.top < frameBox.top - 0.5 ||
          one.right > frameBox.right + 0.5 ||
          one.bottom > frameBox.bottom + 0.5,
      ).length;
      return {
        scale: image.getBoundingClientRect().width / image.naturalWidth,
        regions: regions.length,
        outside,
        collisions: chips.flatMap((chip) =>
          regions.filter(
            (region) =>
              chip.left < region.right &&
              chip.right > region.left &&
              chip.top < region.bottom &&
              chip.bottom > region.top,
          ),
        ).length,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(measured.regions).toBeGreaterThan(0);
    expect(measured.scale).toBeGreaterThanOrEqual(0.45);
    expect(measured.outside).toBe(0);
    expect(measured.collisions).toBe(0);
    expect(measured.scrollWidth).toBeLessThanOrEqual(measured.innerWidth);
  });

for (const width of [1440, 1024])
  test(`at ${width} the hero demo shows the whole shot`, async ({ page, isMobile }) => {
    test.skip(isMobile, "the desktop project only");
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    const measured = await page.evaluate(() => {
      const frame = document.querySelector(".home-demo")?.getBoundingClientRect();
      const image = document.querySelector<HTMLImageElement>(".home-demo img");
      if (!frame || !image) throw new Error("home has no demo");
      const drawn = image.getBoundingClientRect();
      return {
        ratio: frame.width / frame.height,
        sameWidth: Math.abs(drawn.width - frame.width),
        sameHeight: Math.abs(drawn.height - frame.height),
      };
    });
    expect(measured.ratio).toBeCloseTo(1280 / 720, 2);
    expect(measured.sameWidth).toBeLessThan(0.5);
    expect(measured.sameHeight).toBeLessThan(0.5);
  });

/*
 * PS-366: the local band's paragraph is two sentences (at most 45 words), centred and at most 60ch wide,
 * so it reads as a paragraph, not five centred lines. It keeps the three facts of the security page:
 * a page shot leaves only when asked, an upload goes only to the named server, and a project's own AI
 * model gets the three crops of a changed region, never a whole shot.
 */
for (const scheme of ["light", "dark"] as const)
  test(`${scheme}: the local band's paragraph is short and at most 60ch wide`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const band = page.getByTestId("home-column").nth(2).locator("p").first();
    const text = (await band.innerText()).trim();
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(45);
    expect(text).toMatch(/leaves the machine only when you ask/);
    expect(text).toMatch(/three crops of a changed region, never a whole shot/);
    const widths = await band.evaluate((p) => {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(60);
      probe.style.font = getComputedStyle(p).font;
      probe.style.visibility = "hidden";
      probe.style.position = "absolute";
      p.append(probe);
      const sixtyCh = probe.getBoundingClientRect().width;
      probe.remove();
      return { box: p.getBoundingClientRect().width, sixtyCh };
    });
    expect(widths.box).toBeLessThanOrEqual(widths.sixtyCh * 1.02);
  });
