import { type Locator, type Page, expect, test } from "@playwright/test";
import { createOrg, createProject, openSettings } from "./orgs-page";
import { png } from "./png";
import { SERVER } from "./ports";

/**
 * Flakes on the server (ob 1724): a flaky shot under each policy, uploaded as the CLI sends it,
 * gets its badge and the build's summary line; the policy control copies a config line; the
 * Flakes list resolves and reopens. The uploads go straight to the API: the CLI's re-capture
 * needs a browser, and what the server stores is the same form either way.
 */

const SHA_MAIN = "a".repeat(40);
const SHA_WORK = "b".repeat(40);
const WHITE = png(40, 40);
const CHANGED = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);

async function submit(input: Locator, value: string, button: Locator) {
  await input.fill(value);
  await button.click();
}

/** Sign in, make an org and a project, and issue a CI token; returns it and the project id. */
async function provision(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await createOrg(page, "Flake Co");
  await createProject(page, "flaky");
  await openSettings(page, "flaky");
  await submit(
    page.getByLabel("Token name, e.g. github-actions"),
    "ci",
    page.getByRole("button", { name: "Issue token" }),
  );
  const token = (await page.getByTestId("issued-token").textContent()) ?? "";
  const projectId = /\/projects\/([^/]+)/.exec(page.url())?.[1] ?? "";
  expect(projectId).not.toBe("");
  return { token, projectId };
}

/** `png()`'s buffer may sit on a shared buffer, which `Blob` does not take: copy it out. */
const pngBlob = (buf: Buffer) => new Blob([new Uint8Array(buf)], { type: "image/png" });

type Shot = { name: string; png: Buffer; flaky?: "review" | "skip" };

/** The CLI's form for one shot; a flaky one carries its record and runs 2 and 3, run 2 differing. */
function shotForm(shot: Shot): FormData {
  const form = new FormData();
  const meta: Record<string, unknown> = {
    name: shot.name,
    platform: "linux",
    browser: "chromium",
    viewport: "40x40",
    theme: "light",
    tags: ["web"],
    fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
  };
  if (shot.flaky) {
    meta["flaky"] = shot.flaky;
    meta["flake"] = {
      runs: 3,
      differed: [2],
      regions: [],
      engineVersion: "e2e",
      policy: shot.flaky,
    };
    form.set("flake:2", pngBlob(WHITE), "run2.png");
    form.set("flake:3", pngBlob(shot.png), "run3.png");
  }
  form.set("meta", JSON.stringify(meta));
  form.set("file", pngBlob(shot.png), "shot.png");
  return form;
}

/** Open a build, put each shot, finalise: the server diffs in the finalise request. */
async function uploadBuild(token: string, build: object, shots: Shot[]) {
  const headers = { authorization: `Bearer ${token}` };
  const opened = await fetch(`${SERVER}/api/v1/builds`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(build),
  });
  expect(opened.status).toBe(201);
  const { id }: { id: string } = await opened.json();
  for (const shot of shots) {
    const put = await fetch(`${SERVER}/api/v1/builds/${id}/snapshots`, {
      method: "PUT",
      headers,
      body: shotForm(shot),
    });
    expect(put.status).toBe(200);
  }
  const done = await fetch(`${SERVER}/api/v1/builds/${id}/finalize`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ snapshots: shots.length }),
  });
  expect(done.status).toBe(200);
  return id;
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
}

test("a flaky shot under each policy: badge, summary line, config line, resolve and reopen", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { token, projectId } = await provision(page);
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: WHITE },
    { name: "ticker", png: WHITE },
  ]);
  // `created_at` has second resolution; a gap keeps "newest first" unambiguous.
  await page.waitForTimeout(1100);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [
      { name: "hero", png: CHANGED, flaky: "review" },
      { name: "ticker", png: CHANGED, flaky: "skip" },
    ],
  );

  // The project page: the review-policy shot waits; the skipped one is counted on its own line.
  await open(page, `/projects/${projectId}`);
  const row = page.getByTestId("build-row").first();
  await expect(row.getByTestId("to-review")).toHaveText("1 to review");
  await expect(row.getByTestId("skipped-flaky-count")).toHaveText("1 skipped: flaky");

  // The build page: both cards badged, the header's line, and the build still waits on review.
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("skipped-flaky-count")).toHaveText("1 skipped: flaky");
  const badges = page.getByTestId("flaky-badge");
  await expect(badges).toHaveCount(2);
  await expect(badges.filter({ hasText: "skipped: flaky" })).toHaveCount(1);
  await expect(badges.filter({ hasText: /^flaky$/ })).toHaveCount(1);
  await expect(page.getByTestId("build-status")).toHaveText("changes");

  // The skipped shot's panel: the runs side by side, how many differed, the policy in effect.
  await page
    .getByRole("link", { name: /ticker/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const panel = page.getByTestId("flake-panel");
  await expect(panel.getByTestId("flaky-badge")).toHaveText("skipped: flaky");
  await expect(panel.getByTestId("flake-differed")).toHaveText("1 of 3 runs differed (run 2)");
  await expect(panel.getByTestId("flake-run")).toHaveCount(3);
  await expect(panel.locator('[data-testid="flake-run"][data-differed="true"]')).toHaveCount(1);
  await expect(panel.getByTestId("flaky-policy")).toContainText("skip: it does not wait");

  // The policy control offers the other policy and copies its line; nothing changes on the server.
  const control = panel.getByTestId("flaky-policy-control");
  await expect(control.getByTestId("flaky-route-line")).toHaveText('"flaky": "review"');
  await expect(control.getByTestId("flaky-story-tag")).toHaveText("pixelslash-flaky-review");
  await expect(control).toContainText("takes effect from the next build");
  await control.getByRole("button", { name: "copy" }).first().click();
  await expect(control.getByRole("button", { name: "copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('"flaky": "review"');

  // The Flakes list: both open; resolve one with a note, then reopen it.
  await panel.getByTestId("flaky-badge").click();
  await expect(page).toHaveURL(/\/flakes#flake-/);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const flakes = page.getByTestId("flake");
  await expect(flakes).toHaveCount(2);
  const ticker = flakes.filter({ hasText: "ticker" });
  await expect(ticker).toHaveAttribute("data-status", "open");
  await expect(ticker.getByTestId("flake-differed")).toHaveText("1 of 3 runs differed (run 2)");
  await ticker.getByRole("button", { name: "Resolve" }).click();
  await ticker.getByLabel("Resolution note (optional)").fill("froze the ticker");
  await ticker.getByRole("button", { name: "Resolve" }).click();
  await expect(ticker).toHaveAttribute("data-status", "resolved");
  await expect(ticker.getByTestId("flake-resolution")).toContainText("by e2e-octocat");
  await expect(ticker.getByTestId("flake-resolution")).toContainText("froze the ticker");
  // Open flakes first: the resolved one moves below the open one.
  await expect(flakes.first()).toContainText("hero");
  await ticker.getByRole("button", { name: "Reopen" }).click();
  await expect(ticker).toHaveAttribute("data-status", "open");
});
