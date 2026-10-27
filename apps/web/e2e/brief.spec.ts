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
 * A build's brief (PS-232): sent with the build, shown on the build and branch pages as the
 * uploader's plain text, and read by the summary, whose closing sentence says whether the changes
 * match it. The model is the e2e stub.
 */

const BRIEF = [
  "Nudge the **hero** text.",
  "<b>Not bold</b>",
  "Line three.",
  "Line four.",
  "Line five: only shown once the brief is opened.",
].join("\n");

test("a brief is shown as text, and the summary reads the build against it", async ({ page }) => {
  const { token, projectId } = await provision(page, "Brief Co", "briefed");
  const form = page.getByTestId("model-settings");
  await form.getByTestId("model-base-url").fill(`${STUB}/v1`);
  await form.getByTestId("model-name").fill("deepseek-flash");
  await form.getByTestId("model-key").fill("sk-e2e-model");
  await form.getByTestId("model-save").click();
  await expect(form.getByTestId("model-key-set")).toHaveText(`Key set for ${STUB}/v1`);

  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    {
      branch: "work",
      commitSha: SHA_WORK,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
      brief: `  ${BRIEF}\n`,
    },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await explained(page);
  const brief = page.getByTestId("build-brief");
  await expect(brief).toContainText("The uploader's words");
  // Plain text: the markdown and the tag are shown as typed, not rendered.
  await expect(brief.getByTestId("brief-text")).toHaveText(BRIEF);
  await expect(brief.locator("strong, b")).toHaveCount(0);
  await expect(brief.getByTestId("brief-text")).toHaveAttribute("data-collapsed", "");
  await brief.getByTestId("brief-toggle").click();
  await expect(brief.getByTestId("brief-text")).not.toHaveAttribute("data-collapsed");
  await expect(brief.getByTestId("brief-toggle")).toHaveText("Show less");

  const summary = page.getByTestId("build-summary");
  await expect(summary.getByTestId("summary-sentence")).toHaveText(
    /^The hero's text edges moved by a sub-pixel\./,
  );
  await expect(summary.getByTestId("summary-match")).toHaveText(
    /^Against the brief: the hero changed as the brief says; nothing it describes is missing\./,
  );
  await expect(summary.getByTestId("summary-model")).toContainText("read against the brief");
  // The brief decides nothing: the build waits on a person as it would without one.
  await expect(page.getByTestId("build-status")).toHaveText("changes");

  await open(page, `/projects/${projectId}/branches/work`);
  await expect(page.getByTestId("build-brief").getByTestId("brief-text")).toHaveText(BRIEF);

  // A brief with nothing changed is no match: the page says there was nothing to read against it.
  const same = await uploadBuild(
    token,
    {
      branch: "same",
      commitSha: "c".repeat(40),
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
      brief: "Change nothing.",
    },
    [{ name: "hero", png: WHITE }],
  );
  await open(page, `/projects/${projectId}/builds/${same}`);
  await expect(page.getByTestId("summary-counts")).toHaveText(
    /^Nothing changed, so there is nothing to read against the brief\./,
  );
});
