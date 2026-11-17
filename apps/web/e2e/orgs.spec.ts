import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, open, test } from "./fixtures";
import { createOrg, createProject, openSettings } from "./orgs-page";

/** On a fresh project's settings: issue a CI token, see it once, revoke it, and save the default branch. */
async function issueToken(page: Page) {
  await expect(page.getByRole("heading", { name: "storefront · settings" })).toBeVisible();
  await expect(page.getByTestId("no-tokens")).toBeVisible();
  await expect(page.locator("[data-hydrated=true]")).toHaveCount(1);
  // Empty, the button is grey and says why rather than doing nothing.
  await expect(page.getByRole("button", { name: "Issue token" })).toBeDisabled();
  await expect(page.getByText("Name the token first")).toBeVisible();

  await page.getByLabel("Token name, e.g. github-actions").fill("github-actions");
  await page.getByRole("button", { name: "Issue token" }).click();
  const token = (await page.getByTestId("issued-token").locator("code").textContent()) ?? "";
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
}

/**
 * The one test that makes an org, a project and a CI token by clicking. Every other spec has them
 * written straight to the D1 (`provision` in fixtures.ts), so this is where those three flows are
 * proved in a browser.
 */
test("create an org, a project and a CI token by clicking; an empty org says what a project is, and an invite can be withdrawn", async ({
  page,
}) => {
  await open(page, "/orgs");
  const orgName = `Fresh Co ${randomUUID().slice(0, 8)}`;
  const orgId = await createOrg(page, orgName);
  const empty = page.getByTestId("empty-org");
  await expect(empty).toContainText("No projects yet");
  await expect(page.getByTestId("upload-command").locator("code")).toContainText(
    "pixelslash upload",
  );
  await expect(page.getByTestId("upload-command").locator("code")).toContainText("--server http");

  // A disabled button is grey, says why, and is a real disabled control.
  await page.getByRole("button", { name: "+ New project" }).first().click();
  const create = page.getByRole("button", { name: "Create project" });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute("title", "Type a name first.");
  await expect(page.getByRole("dialog")).toContainText("Type a name first.");
  expect(await create.evaluate((el) => getComputedStyle(el).cursor)).toBe("not-allowed");
  await expect(page.getByLabel("New project name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await createProject(page, "storefront");
  await expect(page.getByTestId("project-row")).toHaveCount(1);
  await expect(page.getByTestId("project-row")).toContainText("no builds yet");

  // The link inside the stretched row takes its own click; a click elsewhere on the row follows the row.
  const projectRow = page.getByTestId("project-row");
  await projectRow.getByRole("link", { name: "Set up uploads →" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/settings/);
  await page.goBack();
  await projectRow.click({ position: { x: 600, y: 3 } });
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  // A project with no builds says how to make one: the token, then the exact upload command.
  const emptyProject = page.getByTestId("empty-project");
  await expect(emptyProject).toContainText("No builds yet");
  await expect(emptyProject.getByTestId("upload-command").locator("code")).toContainText(
    `pixelslash upload DIR --server ${new URL(page.url()).origin}`,
  );
  await page.goBack();
  await expect(page.getByTestId("project-row")).toHaveCount(1);

  await page.getByRole("link", { name: /^Members/ }).click();
  await page.getByLabel("Invite a member by GitHub login or email").fill("octo-dev");
  await page.getByRole("button", { name: "Invite", exact: true }).last().click();
  const pending = page.getByTestId("invite-row");
  await expect(pending).toContainText("octo-dev");
  await expect(pending).toContainText("pending");
  await expect(page.getByTestId("member-row")).toHaveCount(1);

  await pending.getByRole("button", { name: /Withdraw/ }).click();
  await expect(page.getByTestId("invite-row")).toHaveCount(0);
  await expect(page.getByTestId("org-people")).toContainText("0 invites pending");

  // The Timings tab: the link, the ?tab=timings URL and the loader that reads the builds. With no
  // build yet it says so (the rows and the numbers are render and query tests).
  await page.getByRole("link", { name: "Timings", exact: true }).click();
  await expect(page).toHaveURL(/tab=timings/);
  await expect(page.getByTestId("timings-empty")).toContainText(
    "No finished builds in the last 30 days",
  );

  // Issue a CI token from the project's settings, through its row's gear.
  await open(page, `/orgs?org=${orgId}`);
  await openSettings(page, "storefront");
  await issueToken(page);
});

/** The settings page's diff location form: a save survives a reload. What a CI project's upload then does is `local-build/upload.local-build.test.ts`. */
test("the diff location is saved from the project settings and survives a reload", async ({
  page,
  provision,
}) => {
  const { projectId } = await provision({ org: "Ci Co", project: "ci-shots" });
  await open(page, `/projects/${projectId}/settings`);
  const inCi = page.getByRole("radio", { name: /^In CI/ });
  await expect(inCi).not.toBeChecked();
  await page.getByText("In CI", { exact: true }).click();
  // Reload only once the save's server call has returned: its response is what makes the value stick.
  const saved = page.waitForResponse(
    (res) => res.request().method() === "POST" && !!res.request().postData()?.includes('"ci"'),
  );
  await page.getByRole("button", { name: "Save diff location" }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("radio", { name: /^In CI/ })).toBeChecked();
});
