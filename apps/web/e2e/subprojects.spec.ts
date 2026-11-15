import { expect, test } from "@playwright/test";
import { createOrg, createProject, openSettings } from "./orgs-page";

test("a subproject is added on its project's settings and shown nested under it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs/);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const orgId = await createOrg(page, "Nest Co");
  await createProject(page, "storefront");

  // A top-level project's settings offer the form; adding one opens the subproject's page.
  await openSettings(page, "storefront");
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const add = page.getByTestId("add-subproject");
  await add.getByLabel("Subproject name, e.g. e2e").fill("e2e");
  await add.getByRole("button", { name: "Add a subproject" }).click();
  await expect(page.getByRole("heading", { name: "e2e", exact: true })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: /breadcrumb/i });
  await expect(crumbs.getByRole("link", { name: "storefront" })).toBeVisible();

  // Its settings keep its own diff location and send the inherited ones to the parent.
  // With no builds yet, its empty state sends you to the parent for the token, and names the flag.
  const empty = page.getByTestId("empty-project");
  await expect(empty.getByTestId("upload-command")).toContainText("--subproject e2e");
  await expect(empty.getByRole("link", { name: "storefront's settings" })).toBeVisible();
  await page.goto(`${page.url()}/settings`);
  const inherited = page.getByTestId("inherited-settings");
  await expect(inherited).toContainText("This is a subproject of storefront");
  await expect(page.getByTestId("diff-location")).toBeVisible();
  await expect(page.getByTestId("upload-command")).toContainText("--subproject e2e");
  await expect(page.getByTestId("add-subproject")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Issue token" })).toHaveCount(0);
  await inherited.getByRole("link", { name: "Open storefront's settings" }).click();
  await expect(page.getByTestId("add-subproject")).toBeVisible();

  // The parent's page lists it above its own builds.
  await page.goto(page.url().replace(/\/settings$/, ""));
  await expect(page.getByTestId("subproject-row")).toHaveCount(1);
  await expect(page.getByTestId("subproject-row")).toContainText("e2e");

  // The org page lists it as an indented row under its project.
  await page.goto(`/orgs?org=${orgId}`);
  await expect(page.getByTestId("project-row")).toHaveCount(1);
  const sub = page.getByTestId("subproject-row");
  await expect(sub).toHaveCount(1);
  await expect(sub).toContainText("e2e");
  await expect(
    page.getByTestId("project-row").locator("xpath=following-sibling::*[1]"),
  ).toHaveAttribute("data-testid", "subproject-row");
});
