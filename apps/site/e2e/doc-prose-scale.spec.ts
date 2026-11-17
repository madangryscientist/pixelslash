import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * Doc pages read on the kit's prose scale (PS-403): inside a `Prose` the body is 16px, an h3 20px
 * and an h2 24px. Measured in both themes at 1440 on /docs/cli, and on /self-host so the shared
 * `DocBody` stays on the same scale.
 */

type Sizes = { body: number; h2: number; h3: number | null };

async function px(page: Page, selector: string): Promise<number | null> {
  const found = page.locator(`[data-doc] ${selector}`).first();
  if ((await found.count()) === 0) return null;
  return found.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
}

async function sizes(page: Page, path: string): Promise<Sizes> {
  await page.goto(path, { waitUntil: "networkidle" });
  return {
    body: (await px(page, "p")) ?? 0,
    h2: (await px(page, "h2")) ?? 0,
    h3: await px(page, "h3"),
  };
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}: the reading scale`, () => {
    test.skip(({ isMobile }) => isMobile, "measured at 1440 on the desktop project");
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });

    test("/docs/cli: body 16px, h3 20px, h2 24px", async ({ page }) => {
      const found = await sizes(page, "/docs/cli");
      expect(found).toEqual({ body: 16, h2: 24, h3: 20 });
    });

    test("/self-host: body 16px and h2 24px", async ({ page }) => {
      const found = await sizes(page, "/self-host");
      expect(found.body).toBe(16);
      expect(found.h2).toBe(24);
    });
  });
}
