import { expect, type Page } from "@playwright/test";
import { dragOver } from "./draw";
import { SERVER } from "./ports";
import { showPanel } from "./snapshot-viewer";

const HYDRATION = /hydrat|react\.dev\/errors\/(418|423|425)/i;

/**
 * On a changed shot: flag a false positive with a note and a drawn area, reload, and the badge,
 * the note and the area are still there, with no hydration error. The review decision is untouched.
 */
export async function flagFalsePositive(page: Page) {
  const hydrationErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && HYDRATION.test(msg.text())) hydrationErrors.push(msg.text());
  });
  page.on("pageerror", (error) => {
    if (HYDRATION.test(error.message)) hydrationErrors.push(error.message);
  });
  const reviewState = await page.getByTestId("review-state").textContent();

  await page.getByRole("button", { name: "Flag detection" }).click();
  const form = page.getByRole("form", { name: "Flag detection" });
  await form.getByText("False positive", { exact: true }).click();
  await form.getByLabel("Note (optional)").fill("anti-aliasing on the heading");
  await form.getByRole("button", { name: "Mark an area" }).click();
  await dragOver(page, page.getByTestId("flag-draw").last(), [0.2, 0.2], [0.6, 0.5]);
  await expect(form.getByTestId("flag-rect")).toBeVisible();
  await form.getByRole("button", { name: "Flag", exact: true }).click();
  await expect(form).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await showPanel(page);
  const badge = page.getByTestId("detection-flag");
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute("data-kind", "false_positive");
  await expect(badge).toContainText("False positive");
  await expect(badge).toContainText("anti-aliasing on the heading");
  await expect(page.getByTestId("flag-mark").first()).toBeVisible();
  await expect(page.getByTestId("review-state")).toHaveText(reviewState ?? "");
  expect(hydrationErrors).toEqual([]);
}

/** The project page lists the flag, and the export is exactly that flag, keys and rect included. */
export async function expectProjectFlag(page: Page, projectId: string) {
  const row = page.getByTestId("project-flag");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("False positive");
  await expect(row).toContainText("anti-aliasing on the heading");
  const response = await page.request.get(`${SERVER}/projects/${projectId}/flags.json`);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    flags: [
      {
        kind: "false_positive",
        note: "anti-aliasing on the heading",
        rect: { x: expect.any(Number), width: expect.any(Number) },
        keys: { image: expect.stringMatching(/\.png$/), baseline: expect.any(String) },
      },
    ],
  });
}
