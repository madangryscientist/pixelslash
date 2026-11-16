import { expect, test as setup } from "@playwright/test";
import { SIGNED_IN } from "./session";

// Signs the stub user (`e2e-octocat`, github-stub.ts) in once per run through the real button, and
// saves the session for the `chromium` project: every spec starts signed in from it. The sign-in
// flow itself is proved by sign-in.spec.ts and google-sign-in.spec.ts.
setup("sign in through the GitHub stub", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await page.context().storageState({ path: SIGNED_IN });
});
