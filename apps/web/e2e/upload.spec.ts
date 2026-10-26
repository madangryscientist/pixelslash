import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { createOrg, createProject, openSettings } from "./orgs-page";
import { SERVER } from "./ports";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");
// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

/** Fill a form and submit it. The controls stay disabled until hydrated, so fill and click wait for it. */
async function submit(input: Locator, value: string, button: Locator) {
  await input.fill(value);
  await button.click();
}

/** Make an org, a project and a CI token, signing in through the stub first when `signIn`. */
async function provision(page: Page, org: string, project: string, signIn: boolean) {
  if (signIn) {
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  } else {
    await page.goto("/orgs");
  }
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
  expect(token).toMatch(/^psci_/);
  return token;
}

const temps: string[] = [];

test.afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function snapshotDir() {
  const dir = await tempDir("ps-e2e-");
  await mkdir(join(dir, "home"));
  await writeFile(join(dir, "home/desktop.png"), PNG);
  const entry = {
    name: "home",
    path: "/",
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 1, height: 1 },
      theme: "light",
    },
    tags: ["web"],
    file: "home/desktop.png",
    fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}

/** The real CLI against the running app. A non-zero exit is a result, not a throw. */
function upload(dir: string, token: string) {
  const res = spawnSync("bun", [CLI, "upload", dir, "--server", SERVER, "--branch", "e2e"], {
    cwd: ROOT,
    env: { ...process.env, PIXELSLASH_TOKEN: token },
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The CLI's stderr less its one `timing:` line (ob 1791): anything else on it is a warning. */
function withoutTiming(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => !l.startsWith("timing: "))
    .join("\n");
}

async function wrangler(...args: string[]) {
  const { stdout } = await run(
    "bunx",
    ["wrangler", ...args, "--local", "--env", "e2e", "--persist-to", ".wrangler/e2e"],
    { cwd: WEB },
  );
  return stdout;
}

async function rows(sql: string): Promise<Record<string, string>[]> {
  const out = await wrangler("d1", "execute", "DB", "--json", "--command", sql);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

/** The server diffed the first build in the Worker; a second upload baselines on it. */
async function checkServerDiff(
  row: Record<string, string> | undefined,
  token: string,
  dir: string,
) {
  const again = upload(dir, token);
  expect(again.code).toBe(0);
  const secondId = /build: (\S+)/.exec(again.stdout)?.[1] ?? "";
  const [second] = await rows(
    `SELECT b.status, s.diff_status, s.diff_key, s.baseline_key, s.diff_result
     FROM builds b JOIN snapshots s ON s.build_id = b.id WHERE b.id = '${secondId}'`,
  );
  expect(second).toMatchObject({ status: "passed", diff_status: "unchanged" });
  expect(second?.baseline_key).toBe(row?.image_key);
  // The second upload is byte-equal to its baseline (ob 1948): settled with no overlay written.
  expect(second?.diff_key).toBeNull();
  const result: unknown = JSON.parse(second?.diff_result ?? "{}");
  expect(result).toMatchObject({
    sizeChanged: false,
    width: 1,
    height: 1,
    changedPixels: 0,
    settledBy: "identical-bytes",
  });
}

test("the CLI uploads a snapshot dir; rows and R2 objects land under the right org", async ({
  page,
}) => {
  const acme = await provision(page, "Upload Co", "ship", true);
  const rival = await provision(page, "Rival Co", "other", false);
  const dir = await snapshotDir();

  const bad = upload(dir, "psci_not-a-real-token");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("401");

  const ok = upload(dir, acme);
  expect(withoutTiming(ok.stderr)).toBe("");
  expect(ok.code).toBe(0);
  const buildId = /build: (\S+)/.exec(ok.stdout)?.[1] ?? "";
  expect(buildId).not.toBe("");

  const [row] = await rows(
    `SELECT s.name, s.viewport, s.image_key, b.status, b.branch, p.org_id, p.name AS project, o.name AS org
     FROM snapshots s JOIN builds b ON b.id = s.build_id
     JOIN projects p ON p.id = b.project_id JOIN orgs o ON o.id = p.org_id
     WHERE b.id = '${buildId}'`,
  );
  expect(row).toMatchObject({
    name: "home",
    viewport: "1x1",
    status: "passed",
    branch: "e2e",
    org: "Upload Co",
    project: "ship",
  });

  await checkServerDiff(row, acme, dir);

  const out = join(await tempDir("ps-e2e-out-"), "got.png");
  const key = `orgs/${row?.org_id}/${row?.image_key}`;
  await wrangler("r2", "object", "get", `pixelslash-blobs/${key}`, "--file", out);
  expect(await readFile(out)).toEqual(PNG);

  // Another org's token cannot write to this build, and nothing is added to it.
  const crossed = new FormData();
  crossed.set("meta", "{}");
  const cross = await fetch(`${SERVER}/api/v1/builds/${buildId}/snapshots`, {
    method: "PUT",
    headers: { authorization: `Bearer ${rival}` },
    body: crossed,
  });
  expect(cross.status).toBe(404);
  const [held] = await rows(`SELECT count(*) AS n FROM snapshots WHERE build_id = '${buildId}'`);
  expect(held?.n).toBe(1);

  // A finalised build is immutable: a late snapshot is refused and not stored.
  const late = new FormData();
  late.set(
    "meta",
    JSON.stringify({
      name: "late",
      platform: "linux",
      browser: "chromium",
      viewport: "1x1",
      theme: "light",
      tags: [],
      fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
    }),
  );
  late.set("file", new Blob([PNG], { type: "image/png" }), "late.png");
  const refused = await fetch(`${SERVER}/api/v1/builds/${buildId}/snapshots`, {
    method: "PUT",
    headers: { authorization: `Bearer ${acme}` },
    body: late,
  });
  expect(refused.status).toBe(409);
  const [after] = await rows(`SELECT count(*) AS n FROM snapshots WHERE build_id = '${buildId}'`);
  expect(after?.n).toBe(1);

  // A revoked token is refused.
  await page.goto("/orgs");
  await page.getByTestId("org-link").filter({ hasText: "Upload Co" }).click();
  await openSettings(page, "ship");
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("row", { name: /ci/ })).toContainText("revoked");
  const revoked = upload(dir, acme);
  expect(revoked.code).toBe(1);
  expect(revoked.stderr).toContain("401");
});

test("a dir of loose PNGs goes through `import` and `upload`, and the server diffs it", async ({
  page,
}) => {
  const token = await provision(page, "Import Co", "shots", true);
  const pngs = await tempDir("ps-e2e-pngs-");
  await mkdir(join(pngs, "billing"));
  await writeFile(join(pngs, "billing/invoice.png"), PNG);
  const out = join(await tempDir("ps-e2e-import-"), "snaps");
  const made = spawnSync(
    "bun",
    [CLI, "import", pngs, "--out", out, "--viewport", "1x1", "--renderer", "e2e-tool"],
    { cwd: ROOT, encoding: "utf8" },
  );
  expect(made.stderr).toBe("");
  expect(made.status).toBe(0);

  const first = upload(out, token);
  expect(withoutTiming(first.stderr)).toBe("");
  expect(first.code).toBe(0);
  const second = upload(out, token);
  expect(second.code).toBe(0);
  const secondId = /build: (\S+)/.exec(second.stdout)?.[1] ?? "";
  const [row] = await rows(
    `SELECT b.status, s.name, s.viewport, s.theme, s.diff_status, s.env_fingerprint
     FROM builds b JOIN snapshots s ON s.build_id = b.id WHERE b.id = '${secondId}'`,
  );
  expect(row).toMatchObject({
    status: "passed",
    name: "billing/invoice",
    viewport: "1x1",
    theme: "light",
    diff_status: "unchanged",
  });
  expect(row?.env_fingerprint).toContain("e2e-tool");
});

test("a project switched to CI diffs in the CLI: the server stores what it measured (ob 1727)", async ({
  page,
}) => {
  const token = await provision(page, "Ci Co", "ci-shots", true);
  await page.getByLabel(/In CI/).check();
  const saved = page.waitForResponse(
    (res) => res.request().method() === "POST" && !!res.request().postData()?.includes('"ci"'),
  );
  await page.getByRole("button", { name: "Save diff location" }).click();
  expect((await saved).ok()).toBe(true);

  const dir = await snapshotDir();
  expect(upload(dir, token).code).toBe(0);
  const again = upload(dir, token);
  expect(withoutTiming(again.stderr)).toBe("");
  expect(again.code).toBe(0);
  const id = /build: (\S+)/.exec(again.stdout)?.[1] ?? "";
  const [row] = await rows(
    `SELECT b.status, s.diff_status, s.measured_by, s.engine_version, s.diff_key
     FROM builds b JOIN snapshots s ON s.build_id = b.id WHERE b.id = '${id}'`,
  );
  expect(row).toMatchObject({ status: "passed", diff_status: "unchanged", measured_by: "ci" });
  expect(row?.engine_version).toMatch(/^\d+\.\d+\.\d+/);
  expect(row?.diff_key).toMatch(/\.diff\.png$/);
});
