import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/**
 * A composition-only project's findings (ob 1850): uploaded with the shot, listed under it as
 * library gaps and special cases, and boxed on the branch pane where the walk measured them.
 */

const composition = {
  library: "Hack Cove UI",
  gaps: [
    {
      kind: "class",
      selector: "#go",
      tag: "button",
      classes: ["mt-7"],
      style: null,
      box: { x: 10, y: 10, width: 10, height: 10 },
    },
  ],
  special: [
    {
      selector: "#logo",
      reason: "the brand mark is drawn by hand",
      box: { x: 0, y: 20, width: 20, height: 20 },
    },
  ],
};

test("one gap and one special case are listed and drawn on the branch shot", async ({ page }) => {
  const { token, projectId } = await provision(page, "Compose Co", "compose");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED, composition }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  const panel = page.getByRole("region", { name: "Composition" });
  await expect(panel.getByRole("heading", { name: "Hack Cove UI gaps (1)" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Hack Cove UI gaps" })).toContainText("class mt-7");
  await expect(panel.getByRole("list", { name: "Special cases" })).toContainText(
    "the brand mark is drawn by hand",
  );

  // Drawn on the branch pane only, where the image px place them: the gap at a quarter in.
  const gap = page.getByTestId("gap-box");
  await expect(gap).toHaveCount(1);
  await expect(page.getByTestId("special-box")).toHaveCount(1);
  await expect(gap).toHaveAttribute("title", "#go: class mt-7");
  const branch = page.getByRole("figure").filter({ hasText: "Branch" }).locator("img");
  const [img, box] = await Promise.all([branch.boundingBox(), gap.boundingBox()]);
  if (!img || !box) throw new Error("no image or box");
  expect(box.x - img.x).toBeCloseTo(img.width / 4, 0);
  expect(box.width).toBeCloseTo(img.width / 4, 0);
});
