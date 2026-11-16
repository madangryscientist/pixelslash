import { type Page, expect } from "@playwright/test";
import { createOrg, createProject, openSettings } from "../../e2e/orgs-page";

/**
 * Sign in, make an org and a project, and issue a CI token, all by clicking; returns the token and
 * the project id. Only the Docker self-host spec uses it: its D1 is inside the container, where the
 * main suite's store write (`e2e/fixtures.ts`, `provision`) cannot reach.
 */
export async function provisionByClicking(page: Page, org: string, project: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await createOrg(page, org);
  await createProject(page, project);
  await openSettings(page, project);
  await page.getByLabel("Token name, e.g. github-actions").fill("ci");
  await page.getByRole("button", { name: "Issue token" }).click();
  const token = (await page.getByTestId("issued-token").locator("code").textContent()) ?? "";
  const projectId = /\/projects\/([^/]+)/.exec(page.url())?.[1] ?? "";
  expect(projectId).not.toBe("");
  return { token, projectId };
}
