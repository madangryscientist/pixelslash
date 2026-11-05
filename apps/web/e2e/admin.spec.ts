import { expect, test } from "@playwright/test";
import { rivalContext, rivalSession } from "./rival";

/**
 * The operator health page (PS-330). The e2e build lists the stub GitHub user (`e2e-octocat`) in
 * `PIXELSLASH_ADMIN_LOGINS`; everyone else, signed in or not, gets the same 404 as a path that does
 * not exist. The "variable unset" case is the access rule's unit test (`admin-access.test.ts`): the
 * build here always sets it.
 */

test("a visitor who is not signed in gets a 404, not a sign-in redirect", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto("/_admin");
  expect(response?.status()).toBe(404);
  expect(new URL(page.url()).pathname).toBe("/_admin");
  await expect(page.getByTestId("operator-health")).toHaveCount(0);
  await context.close();
});

test("a signed-in user who is not listed gets a 404", async ({ browser }) => {
  const token = await rivalSession("admin-rival", 9101, "Not An Operator Co");
  const context = await rivalContext(browser, token);
  const page = await context.newPage();
  const response = await page.goto("/_admin");
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId("operator-health")).toHaveCount(0);
  // Signed in, so the page they are refused is not a sign-in prompt.
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveCount(0);
  await context.close();
});

test("a listed operator sees the page: every group, and what it cannot read says why", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  // No link to it from a customer page.
  await expect(page.getByRole("link", { name: /operator|admin/i })).toHaveCount(0);

  const response = await page.goto("/_admin");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Operator health", exact: true })).toBeVisible();
  await expect(page.getByTestId("admin-now")).toContainText("as of");
  await expect(page.getByTestId("admin-window-24h")).toContainText("Last 24 hours");
  await expect(page.getByTestId("admin-window-7d")).toContainText("Last 7 days");
  await expect(page.getByTestId("admin-24h-finished")).toContainText("finished");
  // Every step's tail reads p99 only from its gate, and the page names that gate.
  await expect(page.getByTestId("admin-window-24h")).toContainText("99th percentile");
  await expect(page.getByTestId("admin-window-24h")).toContainText("when under 100");

  // The deployment group: the e2e build is stamped, and its database is migrated to the code.
  await expect(page.getByTestId("admin-sha")).toHaveText("e2e");
  await expect(page.getByTestId("admin-unapplied")).toHaveText("none");

  // Storage: counts are numbers; R2 says it cannot be read cheaply, never 0.
  await expect(page.getByTestId("admin-rows-builds")).toBeVisible();
  await expect(page.getByTestId("admin-r2")).toContainText("unavailable:");
  await expect(page.getByTestId("admin-24h-summary-failures")).toContainText("unavailable:");

  // Read-only: nothing on the page acts.
  await expect(page.getByTestId("operator-health").getByRole("button")).toHaveCount(0);
});
