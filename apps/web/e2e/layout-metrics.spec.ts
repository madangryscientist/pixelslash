import { SHA_MAIN, uploadBuild } from "./api-upload";
import { expect, open, test } from "./fixtures";
import { png } from "./png";
import { SERVER } from "./ports";
import { showPanel } from "./snapshot-viewer";

/**
 * Layout metrics (PS-294, `docs/metrics.md`) in the side panel: a per-part table for a shot that has a
 * metrics file, and none for a shot without. The CLI's import and upload of those files, and the API
 * read, are `local-build/upload.local-build.test.ts`.
 */

const BUTTON = {
  version: "1.0",
  root: "button",
  parts: {
    button: {
      box: { x: 0, y: 0, w: 96, h: 40 },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      gap: 8,
      color: { bg: "#2563eb", border: "#1d4ed8" },
    },
    "button.label": {
      box: { x: 40, y: 10, w: 40, h: 20 },
      font: { size: 14, weight: 600, lineHeight: 20 },
      color: { fg: "#ffffff" },
    },
  },
};
const CARD = {
  version: "1.0",
  root: "card",
  parts: {
    card: {
      box: { x: 0, y: 0, w: 320, h: 180 },
      padding: { top: 12, right: 12, bottom: 12, left: 12 },
    },
  },
};

test("the side panel shows a shot's layout metrics, part by part, and none for a plain shot", async ({
  page,
  provision,
}) => {
  const { token, projectId } = await provision({ org: "Metrics Co", project: "parts" });
  const image = png(40, 40);
  const buildId = await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "login", png: image, metrics: BUTTON },
    { name: "home", png: image, metrics: CARD },
    { name: "plain", png: image },
  ]);
  const read = await fetch(`${SERVER}/api/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { build }: { build: { snapshots: { id: string; name: string }[] } } = await read.json();
  const shotUrl = (name: string) =>
    `/projects/${projectId}/builds/${buildId}/snapshots/${build.snapshots.find((s) => s.name === name)?.id}`;

  await open(page, shotUrl("login"));
  await showPanel(page);
  await page.getByTestId("metrics-summary").click();
  await expect(page.getByTestId("metrics-summary")).toHaveText("Layout metrics (2 parts)");
  const parts = page.getByTestId("metrics-part");
  await expect(parts).toHaveCount(2);
  await expect(parts.first()).toContainText("button");
  await expect(parts.first()).toContainText("96×40");
  await expect(parts.first()).toContainText("8 16 8 16");
  await expect(parts.first()).toContainText("#2563eb");
  await expect(parts.nth(1)).toContainText("14/20 · 600");
  await expect(parts.nth(1)).toContainText("fg #ffffff");

  await open(page, shotUrl("home"));
  await showPanel(page);
  await page.getByTestId("metrics-summary").click();
  await expect(page.getByTestId("metrics-part")).toHaveCount(1);
  await expect(page.getByTestId("metrics-part")).toContainText("320×180");

  await open(page, shotUrl("plain"));
  await showPanel(page);
  await expect(page.getByTestId("metrics")).toHaveCount(0);
  await expect(page.getByTestId("metrics-summary")).toHaveCount(0);
});
