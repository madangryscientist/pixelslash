import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";
import { sql } from "./d1";

/**
 * The project's builds list (PS-420): on a phone every field of a build is on the card, and a
 * build stored as `passed` that still has shots to review does not read "passed" beside them.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
/** Screens kept outside the wiped e2e state, for the PR. */
const SHOTS = process.env["PS_SHOT_DIR"] ?? join(WEB, ".wrangler/e2e/shots");

async function capture(page: import("@playwright/test").Page, name: string) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function seed(page: import("@playwright/test").Page) {
  const { token, projectId } = await provision(page, "List Co", "list");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: WHITE },
    { name: "ticker", png: WHITE },
    { name: "footer", png: WHITE },
  ]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const staleId = await uploadBuild(
    token,
    {
      branch: "feature/a-long-branch-name",
      commitSha: SHA_WORK,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
      prNumber: 12,
    },
    [
      { name: "hero", png: CHANGED },
      { name: "ticker", png: CHANGED },
      { name: "footer", png: WHITE },
      { name: "banner", png: CHANGED },
    ],
  );
  // The shape of a build written under an older verdict rule: work to review, status `passed`.
  sql(`UPDATE builds SET status = 'passed' WHERE id = '${staleId}'`);
  return projectId;
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("every field of a build is on its card, inside the viewport", async ({ page }) => {
    const projectId = await seed(page);
    await open(page, `/projects/${projectId}`);

    const card = page.getByTestId("build-card").first();
    await expect(card).toBeVisible();
    const inView = async (testId: string) => {
      const box = await card.getByTestId(testId).boundingBox();
      expect(box, testId).not.toBeNull();
      expect(box?.x ?? -1, testId).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 999), testId).toBeLessThanOrEqual(390);
    };
    for (const testId of ["build-status", "snapshot-mix", "to-review", "rel-time"]) {
      await expect(card.getByTestId(testId)).toBeVisible();
      await inView(testId);
    }
    await expect(card.getByTestId("build-status")).toHaveText("changes");
    await expect(card).not.toContainText("passed");
    await expect(card).toContainText("feature/a-long-branch-name");
    await expect(card).toContainText("PR #12");

    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);

    // The table is not drawn at this width, so the phone is not looking at a cut copy of it.
    await expect(page.getByTestId("build-row").first()).toBeHidden();

    // The bar's legend, the sha and PR captions and the links are all body size or larger.
    const textSizes = await card.evaluate((root) => {
      const found = new Set<number>();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && node.parentElement)
          found.add(parseFloat(getComputedStyle(node.parentElement).fontSize));
      }
      return [...found];
    });
    for (const size of textSizes) expect(size).toBeGreaterThanOrEqual(12);

    await capture(page, "list-phone");
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`on a desktop, ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("a build with work to review does not read passed", async ({ page }) => {
      const projectId = await seed(page);
      await open(page, `/projects/${projectId}`);

      const row = page.getByTestId("build-row").first();
      await expect(row.getByTestId("to-review")).toHaveText(/^[1-9]\d* to review$/);
      await expect(row.getByTestId("build-status")).toHaveText("changes");
      await expect(row).not.toContainText("passed");
      await expect(page.getByTestId("build-card").first()).toBeHidden();

      await capture(page, `list-${scheme}`);
    });
  });
}
