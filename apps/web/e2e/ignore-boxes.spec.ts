import type { Browser, Page, Request } from "@playwright/test";
import { expect, open, test } from "./fixtures";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { dragOver } from "./draw";
import { openSection } from "./snapshot-viewer";
import { rivalContext, rivalSession } from "./rival";

/**
 * Ignore boxes drawn in the review UI (ob 1499): a box dragged over the change and saved re-diffs
 * the open build at once, is hatched with its source, exports as config, and is the org's own.
 */

/** Drag over the 40px Branch shot from image px `from` to `to`, at whatever size it is drawn. */
async function drag(page: Page, from: number, to: number) {
  await dragOver(
    page,
    page.getByTestId("flag-draw").nth(1),
    [from / 40, from / 40],
    [to / 40, to / 40],
  );
}

const isAdd = (url: string, method: string) => method === "POST" && url.includes("/_serverFn/");

/**
 * Another org: the screens are not found, and the owner's write, replayed, adds nothing. The rival
 * is one per repeat (`n`), since `--repeat-each` shares one D1.
 */
async function rivalIsRefused(browser: Browser, n: number, urls: string[], request: Request) {
  const rival = await rivalContext(
    browser,
    await rivalSession(`ignore-rival-${n}`, 90000 + n, `Ignore Rival ${n}`),
  );
  const other = await rival.newPage();
  for (const url of urls) expect((await open(other, url))?.status()).toBe(404);
  // The captured headers carry the owner's cookie; the rival's own comes from its context.
  const { cookie: _owner, ...headers } = await request.allHeaders();
  const replay = await rival.request.post(request.url(), {
    headers,
    data: request.postDataBuffer() ?? undefined,
  });
  // A server fn answers 200 with its error serialized: the project is not found for the rival.
  expect(await replay.text()).toContain("isNotFound");
  await rival.close();
}

test("a box drawn over the change flips the verdict, exports as config, and stays in its org", async ({
  page,
  browser,
  provision,
}, testInfo) => {
  const { token, projectId } = await provision({ org: "Ignore Co", project: "ignores" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("changes");
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await openSection(page, "Tools");
  await expect(page.getByTestId("ignore-boxes")).toBeVisible();
  await expect(page.getByTestId("ignore-box")).toHaveCount(0);
  const snapshotPath = new URL(page.url()).pathname;

  // The change is 10x10 at (10,10); the box covers it with room to spare.
  await page.getByTestId("ignore-draw").click();
  await drag(page, 6, 24);
  await expect(page.getByTestId("ignore-pending")).toContainText("18×18 px at 6,6");
  const added = page.waitForRequest((r) => isAdd(r.url(), r.method()));
  await page.getByTestId("ignore-save-variant").click();
  const request = await added;
  await expect(page.getByTestId("ignore-note")).toHaveText(
    "Saved. Re-diffed 1 shot; the build is passed.",
  );
  // Hatched on both panes, labelled as drawn in the UI.
  await expect(page.locator('[data-testid="ignore-box"][data-source="UI"]')).toHaveCount(2);
  await expect(page.getByTestId("ignore-box-row")).toHaveCount(1);
  await expect(page.getByTestId("ignore-snippet")).toContainText('"chromium-40x40-light"');
  await expect(page.getByTestId("ignore-edge-warning")).toHaveCount(0);

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("passed");

  await open(page, `/projects/${projectId}/settings`);
  await expect(page.getByTestId("ignore-row")).toHaveCount(1);
  await expect(page.getByTestId("ignore-trail-row")).toHaveCount(1);
  await page
    .getByTestId("override-export")
    .getByRole("button", { name: "Export as config" })
    .click();
  const exported = JSON.parse((await page.getByTestId("override-export-json").textContent()) ?? "");
  expect(exported).toEqual({
    variants: [
      {
        name: "chromium-40x40-light",
        browser: "chromium",
        viewport: { width: 40, height: 40 },
        theme: "light",
      },
    ],
    routes: [
      {
        name: "hero",
        variants: {
          "chromium-40x40-light": { ignore: [{ x: 6, y: 6, width: 18, height: 18 }] },
        },
      },
    ],
  });

  await rivalIsRefused(
    browser,
    testInfo.repeatEachIndex,
    [`/projects/${projectId}/settings`, snapshotPath],
    request,
  );
  await open(page, `/projects/${projectId}/settings`);
  await expect(page.getByTestId("ignore-row")).toHaveCount(1);
});
