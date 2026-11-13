import { expect, test } from "@playwright/test";
import { open, provision } from "./api-upload";
import { createProject, openSettings } from "./orgs-page";

/**
 * Twin snapshots (PS-295): the project settings link a twin project of the same org. What a twin
 * row and the Unlinked list say is `src/components/twins.test.tsx`, and which shots are twins is
 * `src/db/twins.test.ts`; this keeps the one thing only a browser proves: the settings form, a
 * server function behind a hydrated select, saves and survives a reload.
 */

test("the project settings link a twin project of the same org, and clear it", async ({ page }) => {
  const { projectId } = await provision(page, "Link Co", "app");
  await open(page, `/projects/${projectId}/settings`);
  // A one-project org has nothing to link to.
  await expect(page.getByTestId("no-twin-options")).toBeVisible();

  // Add a second project from the org page, then link it to the first.
  await page.goBack();
  await createProject(page, "native");
  await openSettings(page, "native");
  const card = page.getByTestId("twin-project");
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await card.getByLabel("Twin project").selectOption({ label: "app" });
  await card.getByRole("button", { name: "Save twin project" }).click();
  await page.reload();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(card.getByLabel("Twin project")).toHaveValue(projectId);
});
