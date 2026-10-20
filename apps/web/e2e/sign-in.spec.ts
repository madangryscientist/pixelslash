import { expect, test } from "@playwright/test";

test("sign in with GitHub, create a project and issue a CI token", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();

  await page.getByLabel("New organization name").fill("Acme");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible();

  // Other specs share this database and add their own orgs to the page.
  const card = page.locator("li", { has: page.getByRole("heading", { name: "Acme" }) }).first();
  await card.getByLabel("New project name").fill("storefront");
  await card.getByRole("button", { name: "Create project" }).click();
  await card.getByRole("link", { name: "Settings" }).click();
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
