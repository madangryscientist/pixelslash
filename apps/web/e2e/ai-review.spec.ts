import { expect, test } from "@playwright/test";
import {
  CHANGED,
  SHA_MAIN,
  SHA_WORK,
  WHITE,
  explained,
  open,
  provision,
  uploadBuild,
} from "./api-upload";
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
  await explained(page);
  await expect(page.getByTestId("build-status")).toHaveText("passed");
  const filtered = page.getByTestId("group-ai-filtered");
  await expect(filtered).toContainText("AI-filtered (1)");
  await expect(filtered.getByTestId("shot-ai-labels")).toHaveText("AI: 1 noise");

  // The build's summary (ob 1668) sits in the header: the model's sentence, linked to the shot, and
  // the counts the page states itself.
  const summary = page.getByTestId("build-summary");
  await expect(summary.getByTestId("summary-sentence")).toHaveText(
    /^The hero's text edges moved by a sub-pixel\./,
  );
  await expect(summary.getByTestId("summary-shot-link")).toHaveAttribute(
    "href",
    new RegExp(`/builds/${buildId}/snapshots/`),
  );
  await expect(summary.getByTestId("summary-counts")).toHaveText(
    "0 unchanged · 1 region labelled likely noise.",
  );
  await expect(summary.getByTestId("summary-model")).toContainText("deepseek-flash");
  await summary.getByTestId("summary-regenerate").click();
  await expect(summary.getByTestId("summary-regenerate")).toHaveText("Regenerate");
  await expect(summary.getByTestId("summary-sentence")).toHaveCount(1);
  await expect(summary.getByRole("alert")).toHaveCount(0);

  await filtered.getByTestId("snapshot-row").getByRole("link").click();
  const notes = page.getByTestId("ai-explanation");
  await expect(notes.getByTestId("ai-auto-passed")).toBeVisible();
  await expect(notes.getByTestId("ai-label")).toHaveText("noise");
  await expect(notes).toContainText("Text edges moved by a sub-pixel.");
  // Every pane that draws the region's box carries its label.
  await expect(page.locator('rect[data-ai-label="noise"]').first()).toBeAttached();
});

test("a build with 10 changed shots gets no summary, says why, and offers no Regenerate", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Big Co", "bigbuild");
  const form = page.getByTestId("model-settings");
  await form.getByTestId("model-base-url").fill(`${STUB}/v1`);
  await form.getByTestId("model-name").fill("deepseek-flash");
  await form.getByTestId("model-key").fill("sk-e2e-model");
  await form.getByTestId("model-save").click();
  await expect(form.getByTestId("model-key-set")).toBeVisible();

  const names = Array.from({ length: 10 }, (_, i) => `page-${i}`);
  await uploadBuild(
    token,
    { branch: "main", commitSha: SHA_MAIN },
    names.map((name) => ({ name, png: WHITE })),
  );
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    names.map((name) => ({ name, png: CHANGED })),
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await explained(page);
  const summary = page.getByTestId("build-summary");
  await expect(summary.getByTestId("summary-too-many")).toHaveText(
    "No AI summary: 10 changed shots (summaries are made for builds with fewer than 10).",
  );
  await expect(summary.getByTestId("summary-skip")).toHaveCount(0);
  await expect(summary.getByTestId("summary-sentence")).toHaveCount(0);
  await expect(summary.getByTestId("summary-regenerate")).toHaveCount(0);
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
  // No model: the summary says so and offers nothing to regenerate; it never invents one.
  await expect(page.getByTestId("summary-skip")).toHaveText("skip: no judge.");
  await expect(page.getByTestId("summary-sentence")).toHaveCount(0);
  await expect(page.getByTestId("summary-regenerate")).toHaveCount(0);
  await page.getByTestId("snapshot-row").getByRole("link").click();
  await expect(page.getByTestId("ai-skip")).toHaveText("skip: no judge. Review the pixels.");
});

/**
 * The org's model (ob 1789): set once in the org's settings, a project reports that it uses it, its
 * builds are explained by it, and a project's own model overrides it until it is removed.
 */
test("a project without its own model uses the org's, and its own overrides it", async ({
  page,
}) => {
  const { token, projectId } = await provision(page, "Shared Co", "shared");
  const settings = `/projects/${projectId}/settings`;
  const inUse = page.getByTestId("model-in-use");
  await expect(inUse).toHaveAttribute("data-source", "none");

  await inUse.getByRole("link", { name: "org settings" }).click();
  await expect(page).toHaveURL(/tab=model/);
  const orgForm = page.getByTestId("model-settings");
  await orgForm.getByTestId("model-base-url").fill(`${STUB}/v1`);
  await orgForm.getByTestId("model-name").fill("org-flash");
  await orgForm.getByTestId("model-key").fill("sk-e2e-model");
  await orgForm.getByTestId("model-auto-pass").check();
  await orgForm.getByTestId("model-save").click();
  await expect(orgForm.getByTestId("model-key-set")).toHaveText(`Key set for ${STUB}/v1`);
  await expect(orgForm.getByTestId("model-key")).toHaveValue("");
  await expect(page.getByText("sk-e2e-model")).toHaveCount(0);

  await open(page, settings);
  await expect(inUse).toHaveAttribute("data-source", "org");
  await expect(inUse).toContainText("Using the org's model (org-flash)");
  await expect(page.getByText("sk-e2e-model")).toHaveCount(0);
  await expect(page.getByTestId("model-key-set")).toHaveCount(0);

  // The org's model reads the project's builds: the stub calls the region noise, auto-pass accepts.
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await explained(page);
  await expect(page.getByTestId("build-status")).toHaveText("passed");
  await expect(page.getByTestId("group-ai-filtered")).toContainText("AI-filtered (1)");
  await expect(page.getByTestId("summary-model")).toContainText("org-flash");

  // A project's own model wins, and removing it falls back to the org's.
  await open(page, settings);
  const form = page.getByTestId("model-settings");
  await form.getByTestId("model-base-url").fill(`${STUB}/v1`);
  await form.getByTestId("model-name").fill("project-flash");
  await form.getByTestId("model-key").fill("sk-e2e-project");
  await form.getByTestId("model-save").click();
  await expect(inUse).toHaveAttribute("data-source", "project");
  await expect(inUse).toHaveText("This project's model");
  await form.getByRole("button", { name: "Use the org's model instead" }).click();
  await expect(inUse).toHaveAttribute("data-source", "org");
  await expect(inUse).toContainText("Using the org's model (org-flash)");
});
