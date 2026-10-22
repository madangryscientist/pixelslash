import { expect, test } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, open, provision, uploadBuild } from "./api-upload";
import { STUB } from "./ports";

/**
 * A project's own model (ob 1473), set on the settings page and answered by the e2e stub, which
 * calls every region noise. With auto-pass on, the changed shot is accepted with no person and the
 * build page lists it as AI-filtered; the shot's page shows the label and the sentence.
 */

test("an opted-in project's model auto-passes a noise-only shot and says why", async ({ page }) => {
  const { token, projectId } = await provision(page, "Model Co", "modelled");
  const form = page.getByTestId("model-settings");
  await form.getByTestId("model-base-url").fill(`${STUB}/v1`);
  await form.getByTestId("model-name").fill("deepseek-flash");
  await form.getByTestId("model-key").fill("sk-e2e-model");
  await form.getByTestId("model-auto-pass").check();
  await form.getByTestId("model-save").click();
  await expect(form.getByTestId("model-key-set")).toHaveText(`Key set for ${STUB}/v1`);
  await expect(form.getByTestId("model-key")).toHaveValue("");
  await expect(page.getByText("sk-e2e-model")).toHaveCount(0);

  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("passed");
  const filtered = page.getByTestId("group-ai-filtered");
  await expect(filtered).toContainText("AI-filtered (1)");
  await expect(filtered.getByTestId("shot-ai-labels")).toHaveText("AI: 1 noise");

  await filtered.getByTestId("snapshot-row").getByRole("link").click();
  const notes = page.getByTestId("ai-explanation");
  await expect(notes.getByTestId("ai-auto-passed")).toBeVisible();
  await expect(notes.getByTestId("ai-label")).toHaveText("noise");
  await expect(notes).toContainText("Text edges moved by a sub-pixel.");
  // Every pane that draws the region's box carries its label.
  await expect(page.locator('rect[data-ai-label="noise"]').first()).toBeAttached();
});

test("with no model a changed shot is reviewed as plain pixels", async ({ page }) => {
  const { token, projectId } = await provision(page, "Plain Co", "plain");
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("changes");
  await expect(page.getByTestId("group-ai-filtered")).toHaveCount(0);
  await page.getByTestId("snapshot-row").getByRole("link").click();
  await expect(page.getByTestId("ai-skip")).toHaveText("skip: no judge. Review the pixels.");
});
