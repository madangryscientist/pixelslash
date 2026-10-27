import { expect, test } from "@playwright/test";
import { createOrg, createProject } from "./orgs-page";

test("an empty org says what a project is, and a pending invite can be withdrawn", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs/);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  await createOrg(page, "Fresh Co");
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
  await page.goBack();
  await expect(page.getByTestId("project-row")).toHaveCount(1);

  await page.getByRole("link", { name: /^Members/ }).click();
  await page.getByLabel("Invite a member by GitHub login").fill("octo-dev");
  await page.getByRole("button", { name: "Invite", exact: true }).last().click();
  const pending = page.getByTestId("invite-row");
  await expect(pending).toContainText("octo-dev");
  await expect(pending).toContainText("pending");
  await expect(page.getByTestId("member-row")).toHaveCount(1);

  await pending.getByRole("button", { name: /Withdraw/ }).click();
  await expect(page.getByTestId("invite-row")).toHaveCount(0);
  await expect(page.getByTestId("org-people")).toContainText("0 invites pending");
});
