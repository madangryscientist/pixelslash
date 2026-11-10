import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * The hero's bottom edge does not show as a hard line (PS-362). The Hero's aurora (`.home-aurora-hero`)
 * is clipped to the hero section, so before the fade its blurred blobs stopped flat at the section's
 * bottom edge. The strip is 40px tall, centred on that edge, full width. Each row's mean luminance is
 * taken, and the largest difference between two adjacent rows is the step the eye sees. Light and dark,
 * at a phone and a desktop width, with reduced motion so the blobs do not drift between shots.
 *
 * Desktop project only: the viewport is set here with test.use, so the phone emulation would change it.
 */
// Half of the unfixed 390 step (3.182 light, 5.399 dark, measured on origin/main) is 1.591; 1.5 sits below it.
const STEP_LIMIT = 1.5;
const STRIP = 40;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
const SCHEMES = ["light", "dark"] as const;

async function edgeStep(page: Page, bottom: number, width: number): Promise<number> {
  const top = Math.round(bottom - STRIP / 2);
  const png = await page.screenshot({
    fullPage: true,
    clip: { x: 0, y: top, width, height: STRIP },
  });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas context");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const means: number[] = [];
    for (let y = 0; y < img.height; y++) {
      let sum = 0;
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const [r = 0, g = 0, b = 0] = data.slice(i, i + 3);
        sum += 0.299 * r + 0.587 * g + 0.114 * b;
      }
      means.push(sum / img.width);
    }
    let largest = 0;
    for (let y = 1; y < means.length; y++) {
      largest = Math.max(largest, Math.abs((means[y] ?? 0) - (means[y - 1] ?? 0)));
    }
    return largest;
  }, png.toString("base64"));
}

for (const viewport of VIEWPORTS) {
  for (const colorScheme of SCHEMES) {
    test.describe(`at ${viewport.width} in ${colorScheme}`, () => {
      test.use({ viewport, colorScheme, reducedMotion: "reduce" });
      test.skip(({ isMobile }) => isMobile, "the desktop project only");

      test("the hero's bottom edge fades rather than cutting across the page", async ({ page }) => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const hero = page
          .locator("section")
          .filter({ has: page.locator("h1") })
          .first();
        await expect(hero).toBeVisible();
        const box = await hero.boundingBox();
        if (!box) throw new Error("the hero section has no box");
        const bottom = box.y + box.height;
        const step = await edgeStep(page, bottom, viewport.width);
        // The measured value, kept in the report: the largest adjacent-row step at this width and theme.
        test.info().annotations.push({ type: "hero-edge-step", description: step.toFixed(3) });
        expect(step, "largest luminance step between adjacent rows").toBeLessThan(STEP_LIMIT);
      });
    });
  }
}
