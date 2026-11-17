import { SIGNED_OUT, expect, open, test } from "./fixtures";

// Signs in itself, so it starts with no session. Not the server's zone or locale, so a date
// formatted in the reader's own fails hydration.
test.use({ storageState: SIGNED_OUT, timezoneId: "America/New_York", locale: "de-DE" });

const HYDRATION = /hydrat|react\.dev\/errors\/(418|423|425)/i;

/**
 * Signing in through the button, then a project's pages in another zone and locale. Creating the
 * org, the project and the token by clicking is orgs.spec.ts; here they are written straight to the
 * D1, so the pages have a project and a dated token row to render.
 */
test("sign in with GitHub, and a project's pages hydrate in the reader's own zone", async ({
  page,
  provision,
}) => {
  const hydrationErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && HYDRATION.test(msg.text())) hydrationErrors.push(msg.text());
  });
  page.on("pageerror", (error) => {
    if (HYDRATION.test(error.message)) hydrationErrors.push(error.message);
  });
  await open(page, "/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();

  const { orgId, orgName, projectId, token } = await provision({
    org: "Acme",
    project: "storefront",
  });
  await open(page, `/orgs?org=${orgId}`);
  await expect(page.getByRole("heading", { name: orgName, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "storefront", exact: true })).toBeVisible();

  await open(page, `/projects/${projectId}`);
  await expect(page.getByTestId("empty-project")).toContainText("No builds yet");

  await open(page, `/projects/${projectId}/settings`);
  await expect(page.getByRole("heading", { name: "storefront · settings" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: token.slice(0, 9) });
  await expect(row).toContainText("active");
  expect(hydrationErrors).toEqual([]);
});
