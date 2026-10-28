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
  await expect(
    panel.getByRole("heading", { name: "Hack Cove UI gaps on Branch (1)" }),
  ).toBeVisible();
  await expect(panel.getByRole("list", { name: "Hack Cove UI gaps" })).toContainText(
    "extra classes on a Hack Cove UI component: mt-7",
  );
  await expect(panel.getByRole("heading", { name: "Special cases on Branch (1)" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Special cases" })).toContainText(
    "the brand mark is drawn by hand",
  );

  // Drawn on the branch pane only, where the image px place them: the gap at a quarter in.
  const gap = page.getByTestId("gap-box");
  await expect(gap).toHaveCount(1);
  await expect(page.getByTestId("special-box")).toHaveCount(1);
  await expect(gap).toHaveAttribute(
    "title",
    "#go: extra classes on a Hack Cove UI component: mt-7",
  );
  const branch = page.getByRole("figure").filter({ hasText: "Branch" }).locator("img");
  const [img, box] = await Promise.all([branch.boundingBox(), gap.boundingBox()]);
  if (!img || !box) throw new Error("no image or box");
  expect(box.x - img.x).toBeCloseTo(img.width / 4, 0);
  expect(box.width).toBeCloseTo(img.width / 4, 0);

  // Hovering a box lights its row, and a row its box. The pointer is still where the click on the
  // build page's link left it, which is over the box now; park it first.
  await page.mouse.move(0, 0);
  const row = panel.getByRole("list", { name: "Hack Cove UI gaps" }).getByRole("listitem");
  await expect(row).not.toHaveAttribute("data-focused");
  await gap.hover();
  await expect(row).toHaveAttribute("data-focused", "true");
  await page.mouse.move(0, 0);
  await expect(row).not.toHaveAttribute("data-focused");
  await row.hover();
  await expect(gap).toHaveCSS("background-color", "rgba(245, 158, 11, 0.4)");

  // The boxes have their own toggle and a legend.
  const toggle = page.getByRole("button", { name: "Composition" });
  await expect(page.getByRole("list", { name: "Composition legend" })).toContainText(
    "Not from Hack Cove UI (1)",
  );
  await toggle.click();
  await expect(gap).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Composition legend" })).toHaveCount(0);
  await toggle.click();
  await expect(gap).toHaveCount(1);

  // The build page's card counts the gaps.
  await page.goBack();
  await expect(page.getByTestId("shot-gaps")).toHaveText("1 gap not from Hack Cove UI · 1 special");
});

test("a new shot, which nothing measured, still has its boxes, placed on the image's own size", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Fresh Co", "fresh");
  const buildId = await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: CHANGED, composition },
  ]);
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  const gap = page.getByTestId("gap-box");
  await expect(gap).toHaveCount(1);
  await expect(page.getByTestId("special-box")).toHaveCount(1);
  const branch = page.getByRole("figure").filter({ hasText: "Branch" }).locator("img");
  const [img, box] = await Promise.all([branch.boundingBox(), gap.boundingBox()]);
  if (!img || !box) throw new Error("no image or box");
  expect(box.x - img.x).toBeCloseTo(img.width / 4, 0);
});
