import { expect, test } from "@playwright/test";
import { createOrg, createProject, openSettings } from "./orgs-page";

test("sign in with GitHub, create a project and issue a CI token", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();

  await createOrg(page, "Acme");
  await createProject(page, "storefront");
  await openSettings(page, "storefront");
  await expect(page.getByRole("heading", { name: "storefront · settings" })).toBeVisible();

  await page.getByLabel("Token name, e.g. github-actions").fill("github-actions");
  await page.getByRole("button", { name: "Issue token" }).click();
  const token = (await page.getByTestId("issued-token").textContent()) ?? "";
  expect(token).toMatch(/^psci_/);
  const row = page.getByRole("row", { name: /github-actions/ });
  await expect(row).toContainText(token.slice(0, 9));
  await expect(row).toContainText("active");

  await page.reload();
  await expect(page.getByTestId("issued-token")).toHaveCount(0);
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("revoked");
});
