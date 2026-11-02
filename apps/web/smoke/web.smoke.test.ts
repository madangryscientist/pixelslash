import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { usageCounts } from "#/db/usage";
import { png } from "../e2e/png";
import { type Server, startServer } from "./harness";

/**
 * The web smoke (PS-15): the built app over HTTP on a local D1, through a smoke org. It is runnable
 * locally only; nothing here is pointed at a deployment. The isolation rule, in this file:
 *
 * - synthetic: the smoke org is `is_smoke = 1`, and the last test proves a run leaves the usage
 *   counts unchanged (and, as a control, that they would move if the org were real);
 * - idempotent: the seed deletes the smoke org's rows before it writes them, with fixed ids;
 * - no outbound side effects: the build calls out to nothing but a closed loopback port;
 * - credentials: the token is `PIXELSLASH_SMOKE_TOKEN` or a fresh random one, never in the repo.
 */
const SMOKE = { org: "smoke-org", user: "smoke-user", project: "smoke-project" };
const REAL = { org: "real-org", user: "real-user", project: "real-project", build: "real-build" };

const token = process.env["PIXELSLASH_SMOKE_TOKEN"] ?? `psci_${randomBytes(24).toString("hex")}`;
const WHITE = png(40, 40);
const CHANGED = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);

/** The smoke org, project and CI token, cleared first so a rerun leaves one of each. */
function smokeSeed() {
  const hash = createHash("sha256").update(token).digest("hex");
  return `
DELETE FROM orgs WHERE id = '${SMOKE.org}';
DELETE FROM users WHERE id = '${SMOKE.user}';
INSERT INTO users (id, login) VALUES ('${SMOKE.user}', 'smoke-bot');
INSERT INTO orgs (id, name, is_smoke) VALUES ('${SMOKE.org}', 'Smoke', 1);
INSERT INTO members (org_id, user_id) VALUES ('${SMOKE.org}', '${SMOKE.user}');
INSERT INTO projects (id, org_id, name) VALUES ('${SMOKE.project}', '${SMOKE.org}', 'web');
INSERT INTO ci_tokens (id, project_id, name, token_hash, prefix, created_by)
  VALUES ('smoke-token', '${SMOKE.project}', 'smoke', '${hash}', '${token.slice(0, 9)}', '${SMOKE.user}');
`;
}

/** A real org with one delivered build and shot: the numbers a smoke run must not move. */
const realSeed = `
INSERT INTO users (id, login) VALUES ('${REAL.user}', 'ada');
INSERT INTO orgs (id, name) VALUES ('${REAL.org}', 'Real');
INSERT INTO members (org_id, user_id) VALUES ('${REAL.org}', '${REAL.user}');
INSERT INTO projects (id, org_id, name) VALUES ('${REAL.project}', '${REAL.org}', 'web');
INSERT INTO builds (id, project_id, commit_sha, branch, status)
  VALUES ('${REAL.build}', '${REAL.project}', '${"c".repeat(40)}', 'main', 'passed');
INSERT INTO snapshots (id, build_id, name, platform, browser, viewport, theme, env_fingerprint, image_key)
  VALUES ('real-shot', '${REAL.build}', 'home', 'linux', 'chromium', '40x40', 'light', 'fp', 'builds/${REAL.build}/home.png');
`;

let server: Server;

beforeAll(async () => {
  server = await startServer();
  server.sql(realSeed);
  server.sql(smokeSeed());
});

afterAll(async () => {
  await server?.stop();
});

const auth = () => ({ authorization: `Bearer ${token}` });

function shotForm(name: string, image: Buffer) {
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify({
      name,
      platform: "linux",
      browser: "chromium",
      viewport: "40x40",
      theme: "light",
      tags: ["smoke"],
      fingerprint: { image: "version:smoke", browser: "chromium 1", fonts: "sha256:f" },
    }),
  );
  form.set("file", new Blob([new Uint8Array(image)], { type: "image/png" }), "shot.png");
  return form;
}

/** Open a build, put one shot, finalise: the CLI's upload, over HTTP. */
async function upload(build: object, image: Buffer) {
  const opened = await fetch(`${server.url}/api/v1/builds`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(build),
  });
  expect(opened.status).toBe(201);
  const { id }: { id: string } = await opened.json();
  const put = await fetch(`${server.url}/api/v1/builds/${id}/snapshots`, {
    method: "PUT",
    headers: auth(),
    body: shotForm("hero", image),
  });
  expect(put.status).toBe(200);
  const done = await fetch(`${server.url}/api/v1/builds/${id}/finalize`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ snapshots: 1 }),
  });
  expect(done.status).toBe(200);
  return id;
}

describe("web smoke", () => {
  test("the build serves its sign-in page and refuses an unknown token", async () => {
    const home = await fetch(server.url);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Sign in");
    const refused = await fetch(`${server.url}/api/v1/me`, {
      headers: { authorization: "Bearer psci_nope" },
    });
    expect(refused.status).toBe(401);
  });

  test("a smoke upload is diffed and reviewable, and the smoke org's token is its only door", async () => {
    const me = await fetch(`${server.url}/api/v1/me`, { headers: auth() });
    expect(me.status).toBe(200);

    const before = await usageCounts(server.db());
    expect(before).toEqual({ builds: 1, snapshots: 1 });

    await upload({ branch: "main", commitSha: "a".repeat(40) }, WHITE);
    const work = await upload(
      {
        branch: "work",
        commitSha: "b".repeat(40),
        mergeBaseSha: "a".repeat(40),
        ancestorShas: ["a".repeat(40)],
      },
      CHANGED,
    );
    const read = await fetch(`${server.url}/api/v1/builds/${work}`, { headers: auth() });
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body).toMatchObject({
      build: { status: "changes", snapshots: [{ name: "hero", diff_status: "changed" }] },
    });

    // The real org's build is invisible to the smoke token, as every other org's is.
    const other = await fetch(`${server.url}/api/v1/builds/${REAL.build}`, { headers: auth() });
    expect(other.status).toBe(404);
  });

  test("a smoke run leaves the usage numbers unchanged, and they would move for a real org", async () => {
    const db = server.db();
    // Two smoke builds and two smoke shots exist now (the test above), and none of them count.
    expect(await usageCounts(db)).toEqual({ builds: 1, snapshots: 1 });

    server.sql(`UPDATE orgs SET is_smoke = 0 WHERE id = '${SMOKE.org}';`);
    const asReal = await usageCounts(server.db());
    server.sql(`UPDATE orgs SET is_smoke = 1 WHERE id = '${SMOKE.org}';`);
    expect(asReal).toEqual({ builds: 3, snapshots: 3 });
    expect(await usageCounts(server.db())).toEqual({ builds: 1, snapshots: 1 });
  });

  test("a rerun of the seed leaves one smoke org and none of the last run's builds", async () => {
    server.sql(smokeSeed());
    expect(await usageCounts(server.db())).toEqual({ builds: 1, snapshots: 1 });
    const mine = await fetch(`${server.url}/api/v1/projects/${SMOKE.project}/builds`, {
      headers: auth(),
    });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ builds: [] });
  });
});
