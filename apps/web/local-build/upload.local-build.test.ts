import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asc, count, eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { setDiffLocation } from "#/db/orgs";
import { builds, orgs, projects, snapshots } from "#/db/schema";
import { revokeCiToken } from "#/db/tokens";
import { png } from "../e2e/png";
import {
  buildIdOf,
  cli,
  cliUpload,
  db,
  removeTemps,
  seed,
  serverUrl,
  tempDir,
  withoutTiming,
  wrangler,
} from "./harness";

/**
 * The real CLI against the local build: `upload` and `import`, the server's diff of what it sent,
 * the rows and R2 objects it lands, and the layout metrics it carries (PS-294, `docs/metrics.md`).
 * Rows are read and written through the app's Drizzle schema and store functions.
 */

afterAll(removeTemps);

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

function snapshotDir() {
  const dir = tempDir("ps-local-build-");
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "home/desktop.png"), PNG);
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
    fingerprint: { image: "version:local-build", browser: "chromium 1", fonts: "sha256:f" },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}

/** Every shot of a build, with its build's status and branch and its org: what an upload landed. */
function shotsOf(buildId: string) {
  return db()
    .select({
      id: snapshots.id,
      name: snapshots.name,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      imageKey: snapshots.imageKey,
      baselineKey: snapshots.baselineKey,
      diffKey: snapshots.diffKey,
      diffStatus: snapshots.diffStatus,
      diffResult: snapshots.diffResult,
      envFingerprint: snapshots.envFingerprint,
      metricsKey: snapshots.metricsKey,
      measuredBy: snapshots.measuredBy,
      engineVersion: snapshots.engineVersion,
      status: builds.status,
      branch: builds.branch,
      orgId: projects.orgId,
      project: projects.name,
      org: orgs.name,
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(eq(snapshots.buildId, buildId))
    .orderBy(asc(snapshots.name));
}

async function shotCount(buildId: string) {
  const [row] = await db()
    .select({ n: count() })
    .from(snapshots)
    .where(eq(snapshots.buildId, buildId));
  return row?.n;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("the CLI against the local build", () => {
  test("the CLI uploads a snapshot dir; rows and R2 objects land under the right org", async () => {
    const ship = await seed();
    const rival = await seed();
    const dir = snapshotDir();

    const bad = cliUpload(dir, "psci_not-a-real-token");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("401");

    const ok = cliUpload(dir, ship.token);
    expect(withoutTiming(ok.stderr)).toBe("");
    expect(ok.code).toBe(0);
    const buildId = buildIdOf(ok.stdout);
    expect(buildId).not.toBe("");

    const [row] = await shotsOf(buildId);
    expect(row).toMatchObject({
      name: "home",
      viewport: "1x1",
      status: "changes", // a new shot on a branch waits for review (PS-284)
      branch: "local-build",
      orgId: ship.orgId,
      project: "web",
    });

    // The server diffed the first build in the Worker; a second upload baselines on it.
    const again = cliUpload(dir, ship.token);
    expect(again.code).toBe(0);
    const [second] = await shotsOf(buildIdOf(again.stdout));
    expect(second).toMatchObject({ status: "changes", diffStatus: "unchanged" });
    expect(second?.baselineKey).toBe(row?.imageKey);
    // The second upload is byte-equal to its baseline (ob 1948): settled with no overlay written.
    expect(second?.diffKey).toBeNull();
    expect(second?.diffResult).toMatchObject({
      sizeChanged: false,
      width: 1,
      height: 1,
      changedPixels: 0,
      settledBy: "identical-bytes",
    });

    const out = join(tempDir("ps-local-build-out-"), "got.png");
    const key = `orgs/${row?.orgId}/${row?.imageKey}`;
    wrangler("r2", "object", "get", `pixelslash-blobs/${key}`, "--file", out);
    expect(readFileSync(out)).toEqual(PNG);

    // Another org's token cannot write to this build, and nothing is added to it.
    const crossed = new FormData();
    crossed.set("meta", "{}");
    const cross = await fetch(`${serverUrl()}/api/v1/builds/${buildId}/snapshots`, {
      method: "PUT",
      headers: auth(rival.token),
      body: crossed,
    });
    expect(cross.status).toBe(404);
    expect(await shotCount(buildId)).toBe(1);

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
        fingerprint: { image: "version:local-build", browser: "chromium 1", fonts: "sha256:f" },
      }),
    );
    late.set("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "late.png");
    const refused = await fetch(`${serverUrl()}/api/v1/builds/${buildId}/snapshots`, {
      method: "PUT",
      headers: auth(ship.token),
      body: late,
    });
    expect(refused.status).toBe(409);
    expect(await shotCount(buildId)).toBe(1);

    // A revoked token is refused. Revoking from the settings page is e2e/orgs.spec.ts.
    await revokeCiToken(db(), ship.userId, ship.tokenId);
    const revoked = cliUpload(dir, ship.token);
    expect(revoked.code).toBe(1);
    expect(revoked.stderr).toContain("401");
  });

  test("a dir of loose PNGs goes through `import` and `upload`, and the server diffs it", async () => {
    const { token } = await seed();
    const pngs = tempDir("ps-local-build-pngs-");
    mkdirSync(join(pngs, "billing"));
    writeFileSync(join(pngs, "billing/invoice.png"), PNG);
    const out = join(tempDir("ps-local-build-import-"), "snaps");
    const made = cli([
      "import",
      pngs,
      "--out",
      out,
      "--viewport",
      "1x1",
      "--renderer",
      "local-build-tool",
    ]);
    expect(made.stderr).toBe("");
    expect(made.code).toBe(0);

    const first = cliUpload(out, token);
    expect(withoutTiming(first.stderr)).toBe("");
    expect(first.code).toBe(0);
    const second = cliUpload(out, token);
    expect(second.code).toBe(0);
    const [row] = await shotsOf(buildIdOf(second.stdout));
    expect(row).toMatchObject({
      status: "changes", // the first upload's new shot is still open, and this one carries it (PS-284)
      name: "billing/invoice",
      viewport: "1x1",
      theme: "light",
      diffStatus: "unchanged",
    });
    expect(row?.envFingerprint).toContain("local-build-tool");
  });

  test("a project switched to CI diffs in the CLI: the server stores what it measured (ob 1727)", async () => {
    const { token, userId, projectId } = await seed();
    // Saving the location from the settings page is e2e/orgs.spec.ts.
    await setDiffLocation(db(), userId, projectId, "ci");

    const dir = snapshotDir();
    expect(cliUpload(dir, token).code).toBe(0);
    const again = cliUpload(dir, token);
    expect(withoutTiming(again.stderr)).toBe("");
    expect(again.code).toBe(0);
    const [row] = await shotsOf(buildIdOf(again.stdout));
    expect(row).toMatchObject({ status: "changes", diffStatus: "unchanged", measuredBy: "ci" });
    expect(row?.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(row?.diffKey).toMatch(/\.diff\.png$/);
  });
});

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

/** A dir of loose PNGs and, for some, their metrics files, through `pixelslash import`. */
function imported(shots: Record<string, object | null>, ...flags: string[]) {
  const dir = tempDir("ps-local-build-metrics-");
  for (const [name, metrics] of Object.entries(shots)) {
    writeFileSync(join(dir, `${name}.png`), png(120, 240));
    if (metrics) writeFileSync(join(dir, `${name}.metrics.json`), JSON.stringify(metrics));
  }
  const out = join(tempDir("ps-local-build-metrics-out-"), "snaps");
  const made = cli(["import", dir, "--out", out, ...flags]);
  expect({ code: made.code, stderr: made.stderr }).toMatchObject({ code: 0 });
  return { out, stdout: made.stdout };
}

describe("layout metrics (PS-294)", () => {
  test("metrics beside imported PNGs, native and web, are uploaded and given by the API read", async () => {
    const { token } = await seed();
    const droid = imported(
      { login: BUTTON, plain: null },
      "--platform",
      "android",
      "--device",
      "Pixel 8 API 35",
      "--scale",
      "3",
    );
    const web = imported({ home: CARD }, "--viewport", "120x240");
    expect(droid.stdout).toContain("metrics: 1");
    expect(web.stdout).toContain("metrics: 1");

    // One build carries the native and the web dir.
    const dir = tempDir("ps-local-build-both-");
    const manifests = [droid.out, web.out].map((d) =>
      JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")),
    );
    for (const d of [droid.out, web.out]) cpSync(d, dir, { recursive: true, force: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: 1, snapshots: manifests.flatMap((m) => m.snapshots) }),
    );
    const up = cliUpload(dir, token, "main");
    expect({ code: up.code, stderr: up.stderr }).toMatchObject({ code: 0 });

    const by = new Map((await shotsOf(buildIdOf(up.stdout))).map((s) => [s.name, s]));
    expect(by.get("home")?.metricsKey).toMatch(/\.metrics\.json$/);
    expect(by.get("login")?.metricsKey).toMatch(/\.metrics\.json$/);
    expect(by.get("plain")?.metricsKey).toBeNull();

    // The API read: a URL for a shot with metrics, null for one without; the URL serves the file.
    const read = async (name: string) => {
      const res = await fetch(`${serverUrl()}/api/v1/snapshots/${by.get(name)?.id}`, {
        headers: auth(token),
      });
      expect(res.status).toBe(200);
      const body: { snapshot: { metrics_url: string | null } } = await res.json();
      return body.snapshot;
    };
    const login = await read("login");
    expect(login.metrics_url).toContain("/images/");
    const file = await fetch(login.metrics_url ?? "");
    expect(file.headers.get("content-type")).toContain("application/json");
    expect(await file.json()).toEqual(BUTTON);
    expect((await read("home")).metrics_url).toContain("/images/");
    expect((await read("plain")).metrics_url).toBeNull();
  });
});
