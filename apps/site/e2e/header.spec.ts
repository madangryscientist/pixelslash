import { type Locator, type Page, expect, test } from "@playwright/test";

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

const SCHEME_CLASS = { light: "latte", dark: "dark" } as const;
type Scheme = keyof typeof SCHEME_CLASS;
const other = (scheme: Scheme): Scheme => (scheme === "dark" ? "light" : "dark");

const toggleOf = (page: Page): Locator => page.getByTestId("theme-toggle");

async function box(locator: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return { x: found.x, y: found.y, w: found.width, h: found.height };
}

/** The scheme classes on <html>: exactly one of them is ever set. */
async function schemeClasses(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ["dark", "latte"].filter((name) => document.documentElement.classList.contains(name)),
  );
}

/** A click before hydration would do nothing, so wait until React owns the button. */
async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="theme-toggle"]');
    return button !== null && Object.keys(button).some((key) => key.startsWith("__reactProps"));
  });
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
    const nav = await box(header.getByTestId("site-nav"));
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
  const nav = page.getByTestId("site-nav");
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

    for (const part of [".home-btn", ".home-demo", ".home-readout", ".home-card"]) {
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
