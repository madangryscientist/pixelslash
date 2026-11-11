import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { open, provision } from "./api-upload";
import { showPanel } from "./snapshot-viewer";
import { png } from "./png";
import { SERVER } from "./ports";

/**
 * Layout metrics (PS-294, `docs/metrics.md`): a native import and a web import, each with a
 * `<name>.metrics.json` beside its PNG, uploaded by the real CLI. The server shows both shots'
 * metrics in the side panel and in the API read; a shot without a file shows neither.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/src/index.ts");

const temps: string[] = [];
test.afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("bun", [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function rows(sql: string): Promise<Record<string, string>[]> {
  const { stdout } = await run(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--json",
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      ".wrangler/e2e",
      "--command",
      sql,
    ],
    { cwd: WEB },
  );
  return JSON.parse(stdout.slice(stdout.indexOf("[")))[0].results;
}

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

/** A generated dir of loose PNGs and, for some, their metrics files. */
async function pngs(prefix: string, shots: Record<string, object | null>) {
  const dir = await tempDir(prefix);
  for (const [name, metrics] of Object.entries(shots)) {
    await writeFile(join(dir, `${name}.png`), png(120, 240));
    if (metrics) await writeFile(join(dir, `${name}.metrics.json`), JSON.stringify(metrics));
  }
  return dir;
}

async function imported(from: string, ...flags: string[]) {
  const out = join(await tempDir("ps-e2e-metrics-out-"), "snaps");
  const made = cli(["import", from, "--out", out, ...flags]);
  expect(made.code, made.stderr).toBe(0);
  return { out, stdout: made.stdout };
}

test("metrics beside imported PNGs are uploaded, shown in the side panel and given by the API read", async ({
  page,
  request,
}) => {
  const { token, projectId } = await provision(page, "Metrics Co", "parts");
  const droid = await imported(
    await pngs("ps-e2e-droid-", { login: BUTTON, plain: null }),
    "--platform",
    "android",
    "--device",
    "Pixel 8 API 35",
    "--scale",
    "3",
  );
  const web = await imported(await pngs("ps-e2e-web-", { home: CARD }), "--viewport", "120x240");
  expect(droid.stdout).toContain("metrics: 1");
  expect(web.stdout).toContain("metrics: 1");

  // One build carries the native and the web dir.
  const dir = await tempDir("ps-e2e-both-");
  const manifests = await Promise.all(
    [droid.out, web.out].map(async (d) =>
      JSON.parse(await readFile(join(d, "manifest.json"), "utf8")),
    ),
  );
  for (const d of [droid.out, web.out]) await cp(d, dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 1, snapshots: manifests.flatMap((m) => m.snapshots) }),
  );
  const up = cli(["upload", dir, "--server", SERVER, "--branch", "main"], {
    PIXELSLASH_TOKEN: token,
  });
  expect(up.code, up.stderr).toBe(0);
  const buildId = /build: (\S+)/.exec(up.stdout)?.[1] ?? "";

  const shots = await rows(
    `SELECT id, name, metrics_key FROM snapshots WHERE build_id = '${buildId}' ORDER BY name`,
  );
  const by = new Map(shots.map((s) => [s.name, s]));
  expect(by.get("home")?.metrics_key).toMatch(/\.metrics\.json$/);
  expect(by.get("login")?.metrics_key).toMatch(/\.metrics\.json$/);
  expect(by.get("plain")?.metrics_key).toBeNull();

  // The API read: a URL for a shot with metrics, null for one without; the URL serves the file.
  const read = async (name: string) => {
    const res = await request.get(`${SERVER}/api/v1/snapshots/${by.get(name)?.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body: { snapshot: { metrics_url: string | null } } = await res.json();
    return body.snapshot;
  };
  const login = await read("login");
  expect(login.metrics_url).toContain("/images/");
  const file = await request.get(login.metrics_url ?? "");
  expect(file.headers()["content-type"]).toContain("application/json");
  expect(await file.json()).toEqual(BUTTON);
  expect((await read("home")).metrics_url).toContain("/images/");
  expect((await read("plain")).metrics_url).toBeNull();

  // The side panel: a per-part table for each shot that has one, and none for the plain shot.
  const shotUrl = (name: string) =>
    `/projects/${projectId}/builds/${buildId}/snapshots/${by.get(name)?.id}`;
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
