import { type Locator, type Page, expect } from "@playwright/test";
import { createOrg, createProject, openSettings } from "./orgs-page";
import { png } from "./png";
import { SERVER } from "./ports";

/**
 * Builds uploaded straight to the API, as the CLI sends them (ob 1724, 1738): a signed-in project
 * with a CI token, a shot's multipart form, and a build opened, filled and finalised.
 */

export const SHA_MAIN = "a".repeat(40);
export const SHA_WORK = "b".repeat(40);
export const WHITE = png(40, 40);
export const CHANGED = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);

async function submit(input: Locator, value: string, button: Locator) {
  await input.fill(value);
  await button.click();
}

/** Sign in, make an org and a project, and issue a CI token; returns it and the project id. */
export async function provision(page: Page, org = "Flake Co", project = "flaky") {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await createOrg(page, org);
  await createProject(page, project);
  await openSettings(page, project);
  await submit(
    page.getByLabel("Token name, e.g. github-actions"),
    "ci",
    page.getByRole("button", { name: "Issue token" }),
  );
  const token = (await page.getByTestId("issued-token").locator("code").textContent()) ?? "";
  const projectId = /\/projects\/([^/]+)/.exec(page.url())?.[1] ?? "";
  expect(projectId).not.toBe("");
  return { token, projectId };
}

/** `png()`'s buffer may sit on a shared buffer, which `Blob` does not take: copy it out. */
const pngBlob = (buf: Buffer) => new Blob([new Uint8Array(buf)], { type: "image/png" });

export type Shot = {
  name: string;
  png: Buffer;
  flaky?: "review" | "skip";
  /** The shot's composition findings, sent as the CLI sends them (ob 1850). */
  composition?: object;
};

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
  if (shot.composition) meta["composition"] = shot.composition;
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
export async function uploadBuild(
  token: string,
  build: object,
  shots: Shot[],
  /** More of the finalise body, such as the CLI's `timings`. */
  finalise: object = {},
) {
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
    body: JSON.stringify({ snapshots: shots.length, ...finalise }),
  });
  expect(done.status).toBe(200);
  return id;
}

export async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
}

/**
 * Wait for the model to finish: explaining runs on the queue after the finalise replies (ob 1875),
 * and the build page reloads itself while a shot or the summary is still explaining.
 */
export async function explained(page: Page, timeout = 30_000) {
  await expect(page.getByTestId("shot-ai-pending")).toHaveCount(0, { timeout });
  await expect(page.getByTestId("summary-pending")).toHaveCount(0, { timeout });
}
