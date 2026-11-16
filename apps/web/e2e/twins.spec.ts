import { expect, open, test } from "./fixtures";

/**
 * Twin snapshots (PS-295): the project settings link a twin project of the same org. What a twin
 * row and the Unlinked list say is `src/components/twins.test.tsx`, and which shots are twins is
 * `src/db/twins.test.ts`; this keeps the one thing only a browser proves: the settings form, a
 * server function behind a hydrated select, saves and survives a reload.
 */

test("the project settings link a twin project of the same org, and clear it", async ({
  page,
  provision,
}) => {
  const app = await provision({ org: "Link Co", project: "app" });
  const projectId = app.projectId;
  await open(page, `/projects/${projectId}/settings`);
  // A one-project org has nothing to link to.
  await expect(page.getByTestId("no-twin-options")).toBeVisible();

  // A second project in the same org, linked to the first from its settings.
  const native = await provision({ project: "native", into: app });
  await open(page, `/projects/${native.projectId}/settings`);
  const card = page.getByTestId("twin-project");
  await card.getByLabel("Twin project").selectOption({ label: "app" });
  await card.getByRole("button", { name: "Save twin project" }).click();
  await page.reload();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(card.getByLabel("Twin project")).toHaveValue(projectId);
});
