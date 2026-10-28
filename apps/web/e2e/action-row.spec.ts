import { type Page, expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";

/**
 * The review bar keeps Accept in one place as j walks shots (PS-264): the title line never pushes
 * the action row, and the review chip stays on screen whatever the title's length.
 */

// Short and long names, with and without a theme pill: the title line differs in width from shot to shot.
const NAMES = [
  "button",
  "overview-palette-roles-with-a-long-title-that-runs-on@theme=catppuccin-mocha@density=compact",
  "footer@theme=dark",
  "hero",
];

/** Go back to shot 1 (k stops at the first shot), then walk every shot with j, reading Accept, the title and the chip. */
async function walk(page: Page) {
  const position = page.getByTestId("position");
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  const title = page.locator("h1");
  const chip = page.getByTestId("review-state").first();
  const width = page.viewportSize()?.width ?? 0;
  const seen: { accept: { x: number; y: number }; title: { y: number; height: number } }[] = [];
  for (let step = 0; step < NAMES.length; step += 1) await page.keyboard.press("k");
  for (let step = 0; step < NAMES.length; step += 1) {
    await expect(position).toHaveText(`${step + 1} of ${NAMES.length}`);
    await expect(accept).toBeVisible();
    const actionBox = await accept.boundingBox();
    const titleBox = await title.boundingBox();
    const chipBox = await chip.boundingBox();
    if (!actionBox || !titleBox || !chipBox)
      throw new Error("Accept, the title or the chip has no box");
    seen.push({ accept: { x: actionBox.x, y: actionBox.y }, title: titleBox });
    // The chip is not clipped or pushed off screen: it ends inside the viewport.
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(width);
    if (step < NAMES.length - 1) await page.keyboard.press("j");
  }
  return seen;
}

test("the action row keeps its place as j walks shots with short and long titles", async ({
  page,
}) => {
  // Two full walks of the shots, one per width, on top of the upload and the sign-in.
  test.setTimeout(90_000);
  const { token, projectId } = await provision(page, "Walk Co", "walk");
  await uploadBuild(
    token,
    { branch: "main", commitSha: SHA_MAIN },
    NAMES.map((name) => ({ name, png: WHITE })),
  );
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "walk", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    NAMES.map((name) => ({ name, png: CHANGED })),
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("group-changed").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();

  // Accept the opened shot, so the walk meets a reviewed shot: its chip and date sit on the title line.
  await page.locator("h1").click();
  await page.keyboard.press("a");
  await expect(page.getByTestId("position")).toHaveText(`2 of ${NAMES.length}`);
  await page.keyboard.press("k");
  await expect(page.getByTestId("review-state").first()).toHaveText(/accepted by/);

  const wide = await walk(page);
  for (const { accept } of wide) expect(accept).toEqual(wide[0]?.accept);

  // At a narrow width the action row lays out below the title on every shot, and stays put.
  await page.setViewportSize({ width: 768, height: 900 });
  const narrow = await walk(page);
  for (const { accept, title } of narrow) {
    expect(accept.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(accept).toEqual(narrow[0]?.accept);
  }
});
