import { expect, test } from "@playwright/test";
import { createOrg } from "./orgs-page";

/**
 * Sign in with Google (PS-274) against the stand-in, which answers as a Google account with the same
 * verified email as its GitHub user: one person, one user, whichever button they press.
 */
test("sign in with Google, then with GitHub as the same email, and stay one user", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();
  await createOrg(page, "Signed in with Google");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();

  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByText("Signed in with Google", { exact: true }).first()).toBeVisible();
});
