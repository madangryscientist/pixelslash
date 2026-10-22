import { expect, test } from "@playwright/test";
import { createOrg, createProject, openSettings } from "./orgs-page";

// Not the server's zone or locale, so a date formatted in the reader's own fails hydration.
test.use({ timezoneId: "America/New_York", locale: "de-DE" });

const HYDRATION = /hydrat|react\.dev\/errors\/(418|423|425)/i;

test("sign in with GitHub, create a project and issue a CI token", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && HYDRATION.test(msg.text())) hydrationErrors.push(msg.text());
  });
  page.on("pageerror", (error) => {
    if (HYDRATION.test(error.message)) hydrationErrors.push(error.message);
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();

  await createOrg(page, "Acme");
  await createProject(page, "storefront");

  // A project with no builds says how to make one: the token, then the exact upload command.
  await page.getByRole("link", { name: "storefront", exact: true }).click();
  const empty = page.getByTestId("empty-project");
  await expect(empty).toContainText("No builds yet");
  await expect(empty.getByTestId("upload-command")).toContainText(
    `pixelslash upload DIR --server ${new URL(page.url()).origin}`,
  );
  await page.goBack();

  await openSettings(page, "storefront");
  await expect(page.getByRole("heading", { name: "storefront · settings" })).toBeVisible();
  await expect(page.getByTestId("no-tokens")).toBeVisible();
  await expect(page.locator("[data-hydrated=true]")).toHaveCount(1);
  // Empty, the button is grey and says why rather than doing nothing.
  await expect(page.getByRole("button", { name: "Issue token" })).toBeDisabled();
  await expect(page.getByText("Name the token first")).toBeVisible();

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

  // The default branch starts at main and is what auto-accepts (ob 1559); a save survives a reload.
  const branch = page.getByLabel("Default branch, e.g. main");
  await expect(branch).toHaveValue("main");
  await branch.fill("master");
  // Reload only once the save's server call has returned: its response is what makes the value stick.
  const saved = page.waitForResponse(
    (res) => res.request().method() === "POST" && !!res.request().postData()?.includes("master"),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Default branch, e.g. main")).toHaveValue("master");
  expect(hydrationErrors).toEqual([]);
});
