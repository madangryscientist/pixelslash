import { type Provision, expect, open, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { highlightToggle } from "./snapshot-viewer";

/**
 * A carried shot is identical to the previous build of its branch, so that build's image is not
 * what the reviewer has to decide: the change against main is. The viewer opens on main for it,
 * names the earlier build when that is what the left pane shows, and switches between the two.
 */

const SHA_NEXT = "c".repeat(40);
const LABEL = '[data-testid="pane-label"]';
const BOXES = 'svg[aria-label="Measured regions"] rect[data-kind="change"]';

async function carriedShot(page: Page, provision: Provision) {
  const { token, projectId } = await provision({ org: "Base Co", project: "base" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "home", png: WHITE },
    { name: "about", png: WHITE },
  ]);
  const feat = [
    { name: "home", png: WHITE },
    { name: "about", png: CHANGED },
  ];
  await uploadBuild(
    token,
    { branch: "feat", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    feat,
  );
  // The same pixels again, before anything was decided.
  const buildId = await uploadBuild(
    token,
    {
      branch: "feat",
      commitSha: SHA_NEXT,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_WORK, SHA_MAIN],
    },
    feat,
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("group-changed").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(page.locator("h1")).toHaveAttribute("title", "about");
}

test("a carried shot opens on Against main and switches to the earlier build by keyboard", async ({
  page,
  provision,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await carriedShot(page, provision);

  const against = page.getByRole("radiogroup", { name: "Compared with" });
  await expect(against.getByRole("radio", { name: "Against main" })).toBeChecked();
  await expect(page.locator(LABEL).first()).toHaveText(/^Main \(baseline\)/);
  // The change is what is being decided, so its boxes are there without asking.
  await expect(highlightToggle(page)).toHaveText("Highlight on");
  await expect(page.locator(BOXES).first()).toBeVisible();
  await expect(page.getByTestId("base-summary")).toContainText(/\d+ changed px .* in \d+ regions?/);

  await against.getByRole("radio", { name: "Against main" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(against.getByRole("radio", { name: /^Against build [0-9a-f]{7}$/ })).toBeChecked();
  await expect(page.locator(LABEL).first()).toHaveText(/^Earlier build on this branch [0-9a-f]{7}/);
  await expect(page.locator(LABEL).first()).not.toContainText("Main");
  await expect(page.locator(BOXES)).toHaveCount(0);
  await expect(page.getByTestId("base-summary")).toHaveText(
    "No change: identical bytes, not diffed.",
  );
  await expect(page.locator(LABEL).first().getByRole("link")).toBeVisible();
});

test("on a phone nothing scrolls sideways", async ({ page, provision }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await carriedShot(page, provision);
  await expect(page.getByRole("radiogroup", { name: "Compared with" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
