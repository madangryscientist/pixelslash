import { expect, type Page } from "@playwright/test";

function group(page: Page, name: string) {
  return page.getByTestId(`group-${name}`);
}

/** The build page on first open: Changed is the tab, its shots are thumbnail cards, the header counts what is left. */
export async function expectBuildWorkspaceOpen(page: Page) {
  await expect(page.getByTestId("tab-changed")).toHaveAttribute("aria-current", "page");
  await expect(group(page, "changed").getByTestId("snapshot-row")).toHaveCount(2);
  await expect(group(page, "changed").getByTestId("shot-thumb")).toHaveCount(2);
  await expect(group(page, "changed")).toContainText("size changed 40×40 → 48×40");
  await expect(page.getByTestId("to-review")).toHaveText("2 to review");
  await expect(page.getByTestId("review-progress")).toContainText("0 of 2 reviewed");
  await expect(page.getByTestId("review-next")).toBeVisible();
  for (const [tab, count] of [
    ["changed", "2"],
    ["new", "1"],
    ["removed", "1"],
    ["unmeasured", "0"],
    ["unchanged", "1"],
  ] as const) {
    await expect(page.getByTestId(`tab-count-${tab}`)).toHaveText(count);
  }
}

/** Walks the other tabs; Unchanged stays folded until asked for. Ends back on Changed. */
export async function walkBuildTabs(page: Page) {
  await page.getByTestId("tab-new").click();
  await expect(group(page, "new").getByTestId("snapshot-row")).toHaveCount(1);
  await page.getByTestId("tab-removed").click();
  await expect(group(page, "removed").getByTestId("snapshot-row")).toHaveCount(1);
  // A tab with nothing in it says so rather than rendering a blank.
  await page.getByTestId("tab-unmeasured").click();
  await expect(page.getByTestId("tab-empty")).toContainText("Nothing in Not measured");
  await page.getByTestId("tab-unchanged").click();
  await expect(group(page, "unchanged").getByTestId("snapshot-row")).toHaveCount(0);
  await page.getByTestId("unchanged-show").click();
  await expect(group(page, "unchanged").getByTestId("snapshot-row")).toHaveCount(1);
  await page.getByTestId("tab-changed").click();
}
