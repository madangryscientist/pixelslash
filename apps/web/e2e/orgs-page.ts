import { type Page, expect } from "@playwright/test";

/** Open the New organization dialog, create the org, and land on it. Returns its id. */
export async function createOrg(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New organization", exact: true }).click();
  await page.getByLabel("New organization name").fill(name);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByLabel("New organization name")).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get("org");
  if (!id) throw new Error(`no org id in ${page.url()}`);
  return id;
}

/** On an org's page: open New project, name it, and wait for its row. */
export async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "+ New project" }).first().click();
  await page.getByLabel("New project name").fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
}

/** On an org's page: a project's settings, through its row's gear. */
export async function openSettings(page: Page, project: string): Promise<void> {
  await page.getByRole("link", { name: `${project} settings` }).click();
}
