import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, provision, uploadBuild } from "./api-upload";
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

test("each window reads snapshots per build and time per snapshot, in both themes, at desktop and phone width", async ({
  browser,
  page,
}) => {
  // A real build with a diffed shot, so the window has a build and a server compare to count.
  const { token } = await provision(page, "Window Figures Co", "figures");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );
  const sizes = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of sizes) {
      const context = await browser.newContext({ colorScheme, viewport });
      const view = await context.newPage();
      await view.goto("/");
      await view.getByRole("link", { name: "Sign in with GitHub" }).click();
      await expect(view).toHaveURL(/\/orgs$/);
      await view.goto("/_admin");
      await expect(view.locator("html")).toHaveClass(
        colorScheme === "dark" ? /dark/ : /^(?!.*dark)/,
      );
      for (const key of ["24h", "7d"]) {
        const figures = view.getByTestId(`admin-${key}-figures`);
        await expect(figures.getByTestId(`admin-${key}-figures-per-build`)).toHaveText(
          /^\d[\d,]* \/ \d[\d,]*( max)? \/ (—|\d[\d,]*) · n=\d[\d,]* builds$/,
        );
        await expect(figures.getByTestId(`admin-${key}-figures-per-snapshot`)).toHaveText(
          / · n=\d[\d,]* compares$/,
        );
        await expect(figures).toContainText("a CI build's times are not in it");
      }
      const overflow = await view.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${colorScheme} at ${viewport.width}`).toBeLessThanOrEqual(0);
      await context.close();
    }
  }
});
