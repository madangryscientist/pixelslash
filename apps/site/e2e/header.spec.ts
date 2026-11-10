import { type Page, expect, test } from "@playwright/test";
import { PAGES } from "../src/content/pages.ts";
import { SCHEME_CLASS, box, hydrated, other, schemeClasses, toggleOf } from "./support/header.ts";
import { menuButton, menuOpen, siteNav } from "./support/site-nav.ts";

/*
 * One header on every page, and the theme toggle in it (PS-329). Each runs on a desktop and a phone
 * (playwright.config.ts). The boxes are read once the served font has loaded, since it sets the width
 * of Get started, and with the page unscrolled.
 */

const VISITED = [
  "/",
  "/docs/",
  "/docs/install/",
  "/pricing/",
  "/compare/",
  "/self-host/",
  "/how-it-works/",
];

declare global {
  interface Window {
    /** Every value <html>'s scheme has had, recorded by the no-flash test's init script. */
    seenSchemes?: string[][];
  }
}

const backgroundOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);

/** What home is really drawn with: its canvas, its body, its header and its text. */
async function homePaint(page: Page) {
  return {
    html: await backgroundOf(page, "html"),
    body: await backgroundOf(page, "body"),
    home: await backgroundOf(page, ".home"),
    text: await page.locator(".home").evaluate((element) => getComputedStyle(element).color),
    header: await backgroundOf(page, "header"),
  };
}

/**
 * The page as the head script alone leaves it: every bundle is blocked, so nothing but that inline
 * script can have set the class, and it is the class the first frame has.
 */
async function withoutBundles(page: Page): Promise<void> {
  await page.route(/\.m?js(\?|$)/, (route) => route.abort());
}

test("the header, logo, toggle, Get started and nav do not move between pages", async ({
  page,
}) => {
  const seen: Record<string, unknown> = {};
  for (const to of VISITED) {
    await page.goto(to, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const header = page.locator("header").first();
    const nav = await box((await siteNav(page)).first());
    seen[to] = {
      header: await box(header),
      logo: await box(header.getByRole("img", { name: "PixelSlash" })),
      toggle: await box(toggleOf(page)),
      getStarted: await box(header.getByRole("link", { name: "Get started" })),
      navLeft: nav.x,
      navTop: nav.y,
    };
  }
  for (const to of VISITED) expect(seen[to], `${to} against /`).toEqual(seen["/"]);
});

test("the nav marks the page it is on, Home included", async ({ page }) => {
  await page.goto("/");
  const nav = await siteNav(page);
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

for (const system of ["light", "dark"] as const) {
  const chosen = other(system);

  test(`on a ${system} system, choosing ${chosen} holds over a reload and a navigation`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: system });
    await page.goto("/pricing", { waitUntil: "networkidle" });
    await hydrated(page);
    expect(await schemeClasses(page)).toEqual([SCHEME_CLASS[system]]);

    await toggleOf(page).click();
    expect(await schemeClasses(page)).toEqual([SCHEME_CLASS[chosen]]);
    await expect(toggleOf(page)).toHaveAccessibleName(`Switch to ${system} theme`);

    // Against the system's preference, so only the stored choice can have set it.
    await page.reload({ waitUntil: "networkidle" });
    expect(await schemeClasses(page)).toEqual([SCHEME_CLASS[chosen]]);
    expect(errors).toEqual([]);

    // Before any bundle: the head script restores the choice on another page by itself.
    await withoutBundles(page);
    await page.goto("/compare", { waitUntil: "domcontentloaded" });
    expect(await schemeClasses(page)).toEqual([SCHEME_CLASS[chosen]]);
  });

  test(`with nothing stored the page follows a ${system} system, before any bundle`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: system });
    await withoutBundles(page);
    for (const to of ["/", "/pricing"]) {
      await page.goto(to, { waitUntil: "domcontentloaded" });
      expect(await schemeClasses(page), to).toEqual([SCHEME_CLASS[system]]);
    }
  });

  test(`on a ${system} system, / never shows the other scheme while it loads`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: system });
    // Every value <html>'s scheme has had since <body> began: from there on the page can paint.
    await page.addInitScript(() => {
      const seen: string[][] = [];
      window.seenSchemes = seen;
      const record = () => {
        if (!document.body) return;
        const now = ["dark", "latte"].filter((name) =>
          document.documentElement.classList.contains(name),
        );
        if (seen.at(-1)?.join() !== now.join()) seen.push(now);
      };
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    expect(await page.evaluate(() => window.seenSchemes)).toEqual([[SCHEME_CLASS[system]]]);
  });

  test(`on a ${system} system, the toggle switches all of / and the choice wins on load`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: system });
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    const before = await homePaint(page);
    await toggleOf(page).click();

    await expect.poll(async () => (await homePaint(page)).home).not.toBe(before.home);
    const after = await homePaint(page);
    expect(after.html).toBe(after.home);
    expect(after.body).toBe(after.home);
    expect(after.text).not.toBe(before.text);
    expect(after.header).not.toBe(before.header);

    // Against the system's preference, so only the stored choice can have set it.
    await page.reload({ waitUntil: "networkidle" });
    expect(await homePaint(page)).toEqual(after);
  });
}

test("the toggle is named, and works from the keyboard", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/pricing", { waitUntil: "networkidle" });
  await hydrated(page);
  const toggle = page.getByRole("button", { name: "Switch to dark theme" });
  await expect(toggle).toBeVisible();

  // Tabbing from the top of the page reaches it: the logo, then the toggle.
  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press("Tab");
    if (await toggle.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await schemeClasses(page)).toEqual(["dark"]);
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeFocused();
});

/*
 * The header stays on top of the home's body, where the demo, its read-out and the cards all stack. As
 * in smoke.spec.ts, what is asserted is what is painted: the header's band is shot as it is, then with
 * everything in the page body hidden, and the two must match. Each part is scrolled to straddle the
 * band. Reduced motion, so nothing moves between the two shots.
 */
for (const scheme of ["light", "dark"] as const) {
  test(`/ scrolled: nothing in the page paints over the header in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    const clip = await page.locator("header").first().boundingBox();
    if (!clip) throw new Error("the header has no box");

    for (const part of [".home-rise a", ".home-demo", ".home-readout", ".home-cards a"]) {
      await page
        .locator(part)
        .first()
        .evaluate(
          (element, middle) => {
            window.scrollBy(0, element.getBoundingClientRect().top - middle);
          },
          clip.y + clip.height / 2,
        );
      const drawn = await page.screenshot({ clip });
      const hide = await page.addStyleTag({
        content: "main * { visibility: hidden !important; }",
      });
      const bare = await page.screenshot({ clip });
      await hide.evaluate((node) => node instanceof Element && node.remove());
      expect(drawn.equals(bare), `${part} painted over the header`).toBe(true);
    }
  });
}

/*
 * The phone pass (PS-313). At 390x844 AppShell folds the nav behind one Menu button: the header is one
 * row, the theme toggle stays in it, and nothing on any page scrolls sideways. `/docs/cli` is the
 * longest doc page (by scrollHeight at 1440). Run on the phone project only, so each case runs once;
 * the 1440 case runs on the desktop project.
 */
const PHONE_PAGES = [...PAGES.map((one) => one.to), "/docs/cli"];
const LABELS = PAGES.map((one) => one.label);

test.describe("at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.skip(({ isMobile }) => !isMobile, "the phone project only");

  for (const scheme of ["light", "dark"] as const) {
    for (const to of PHONE_PAGES) {
      test(`${to} in ${scheme}: one header row, the nav in Menu, no sideways scroll`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(to, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await hydrated(page);

        const header = await box(page.locator("header").first());
        expect(header.h).toBeLessThanOrEqual(57);
        await expect(page.getByTestId("site-nav").filter({ visible: true })).toHaveCount(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);

        // The toggle is in the row, and works with the menu shut.
        await expect(toggleOf(page)).toBeVisible();
        expect(await menuOpen(page)).toBe(false);
        await toggleOf(page).click();
        expect(await schemeClasses(page)).toEqual([SCHEME_CLASS[other(scheme)]]);
        expect(await menuOpen(page)).toBe(false);

        // Menu shows every nav link; Escape shuts it.
        const nav = await siteNav(page);
        for (const label of LABELS) {
          await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
        }
        await page.keyboard.press("Escape");
        expect(await menuOpen(page)).toBe(false);
        await expect(nav).toHaveCount(0);

        // Following a link shuts it.
        await menuButton(page).click();
        const target = to === "/pricing" ? "Security" : "Pricing";
        const href = PAGES.find((one) => one.label === target)?.to ?? "";
        await nav.getByRole("link", { name: target, exact: true }).click();
        await page.waitForURL((url) => url.pathname.replace(/\/$/, "") === href);
        expect(await menuOpen(page)).toBe(false);
      });
    }
  }
});

test.describe("at 390 without JavaScript", () => {
  test.use({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  test.skip(({ isMobile }) => !isMobile, "the phone project only");

  test("Menu opens and shows the nav links", async ({ page }) => {
    await page.goto("/pricing");
    const nav = await siteNav(page);
    for (const label of LABELS) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });
});

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.skip(({ isMobile }) => isMobile, "the desktop project only");

  // On / only: the first test in this file holds every other page's header to /'s.
  test("the header is two rows with every nav link and no Menu", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(menuButton(page)).toBeHidden();
    const nav = page.getByTestId("site-nav").filter({ visible: true });
    for (const label of LABELS) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    const header = await box(page.locator("header").first());
    // The nav sits in a second row, below the brand's.
    expect((await box(nav)).y).toBeGreaterThanOrEqual(header.y + 56);
    expect(header.h).toBeGreaterThan(100);
  });
});

/*
 * A heading anchor lands clear of the header at either width, since scroll-margin-top reads AppShell's
 * --app-header, and the contents list's spy reads the same margin, so at 1440 it marks that heading.
 */
for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test.describe(`a heading anchor at ${width}`, () => {
    test.use({ viewport: { width, height } });
    test.skip(({ isMobile }) => isMobile !== width < 768, "one project per width");

    test("lands below the header", async ({ page }) => {
      await page.goto("/docs/cli#pixelslash-upload", { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await hydrated(page);
      const header = await box(page.locator("header").first());
      const bottom = header.y + header.h;
      const top = async (): Promise<number> => (await box(page.locator("#pixelslash-upload"))).y;
      // Landed: at or below the header, and within the 1rem gap of it, not left lower down the page.
      await expect.poll(top).toBeGreaterThanOrEqual(bottom);
      expect(await top()).toBeLessThanOrEqual(bottom + 20);
      if (width < 768) return;
      await expect(
        page.locator('a[aria-current="location"]').filter({ visible: true }),
      ).toHaveAttribute("href", "#pixelslash-upload");
    });
  });
}
