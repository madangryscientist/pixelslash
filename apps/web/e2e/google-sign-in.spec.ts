import { randomUUID } from "node:crypto";
import { SIGNED_OUT, expect, open, test } from "./fixtures";
import { createOrg } from "./orgs-page";

/**
 * Sign in with Google (PS-274) against the stand-in, which answers as a Google account with the same
 * verified email as its GitHub user: one person, one user, whichever button they press.
 */
// Signs in itself, so it starts with no session.
test.use({ storageState: SIGNED_OUT });

test("sign in with Google, then with GitHub as the same email, and stay one user", async ({
  page,
}) => {
  await open(page, "/");
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();
  const orgName = `Signed in with Google ${randomUUID().slice(0, 8)}`;
  await createOrg(page, orgName);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();

  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByText(orgName, { exact: true }).first()).toBeVisible();
});
