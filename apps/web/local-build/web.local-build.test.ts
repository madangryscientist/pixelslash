import { describe, expect, test } from "vitest";
import { usageCounts } from "#/db/usage";
import { png } from "../e2e/png";
import { db, seed, serverUrl, setSynthetic } from "./harness";

/**
 * The built app over HTTP on a local D1 (PS-15). It is runnable locally and in CI's `web` job;
 * nothing here is pointed at a deployment. The isolation rule, in this file:
 *
 * - synthetic: each test's org is `is_smoke = 1`, and a test proves its uploads leave the usage
 *   counts unchanged (and, as a control, that they would move if the org were real);
 * - its own data: every test seeds its own org with unique ids, and counts are read before and after
 *   in the same test, so no test reads another's rows or assumes an empty D1;
 * - idempotent: the seed with a fixed id deletes that org's rows before it writes them;
 * - no outbound side effects: the build calls out to nothing but a closed loopback port;
 * - credentials: every seed issues its own random CI token, never one from the repo or the env.
 */
const WHITE = png(40, 40);
const CHANGED = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);
const SHA_MAIN = "a".repeat(40);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

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
      tags: ["local-build"],
      fingerprint: { image: "version:local-build", browser: "chromium 1", fonts: "sha256:f" },
    }),
  );
  form.set("file", new Blob([new Uint8Array(image)], { type: "image/png" }), "shot.png");
  return form;
}

/** Open a build, put one shot, finalise: the CLI's upload, over HTTP. */
async function upload(token: string, build: object, image: Buffer) {
  const opened = await fetch(`${serverUrl()}/api/v1/builds`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(build),
  });
  expect(opened.status).toBe(201);
  const { id }: { id: string } = await opened.json();
  const put = await fetch(`${serverUrl()}/api/v1/builds/${id}/snapshots`, {
    method: "PUT",
    headers: auth(token),
    body: shotForm("hero", image),
  });
  expect(put.status).toBe(200);
  const done = await fetch(`${serverUrl()}/api/v1/builds/${id}/finalize`, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ snapshots: 1 }),
  });
  expect(done.status).toBe(200);
  return id;
}

/** A main build and a work build on it that changes the shot: two builds, two shots. */
async function mainThenWork(token: string) {
  await upload(token, { branch: "main", commitSha: SHA_MAIN }, WHITE);
  return upload(
    token,
    {
      branch: "work",
      commitSha: "b".repeat(40),
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
    },
    CHANGED,
  );
}

describe("the local build", () => {
  test("the build serves its sign-in page and refuses an unknown token", async () => {
    const home = await fetch(serverUrl());
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Sign in");
    const refused = await fetch(`${serverUrl()}/api/v1/me`, {
      headers: { authorization: "Bearer psci_nope" },
    });
    expect(refused.status).toBe(401);
  });

  test("a synthetic upload is diffed and reviewable, and its token is its only door", async () => {
    const mine = await seed();
    const real = await seed({ real: true });
    const realBuild = await upload(real.token, { branch: "main", commitSha: SHA_MAIN }, WHITE);

    const me = await fetch(`${serverUrl()}/api/v1/me`, { headers: auth(mine.token) });
    expect(me.status).toBe(200);

    const work = await mainThenWork(mine.token);
    const read = await fetch(`${serverUrl()}/api/v1/builds/${work}`, {
      headers: auth(mine.token),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      build: { status: "changes", snapshots: [{ name: "hero", diff_status: "changed" }] },
    });

    // The real org's build is invisible to the synthetic org's token, as every other org's is.
    const other = await fetch(`${serverUrl()}/api/v1/builds/${realBuild}`, {
      headers: auth(mine.token),
    });
    expect(other.status).toBe(404);
  });

  test("a synthetic org's uploads leave the usage numbers unchanged, and they would move for a real org", async () => {
    const mine = await seed();
    const before = await usageCounts(db());
    await mainThenWork(mine.token);
    expect(await usageCounts(db())).toEqual(before);

    await setSynthetic(mine.orgId, false);
    const asReal = await usageCounts(db());
    await setSynthetic(mine.orgId, true);
    expect(asReal).toEqual({ builds: before.builds + 2, snapshots: before.snapshots + 2 });
    expect(await usageCounts(db())).toEqual(before);
  });

  test("a rerun of the seed leaves one synthetic org and none of the last run's builds", async () => {
    const first = await seed({ fixedId: "rerun" });
    await upload(first.token, { branch: "main", commitSha: SHA_MAIN }, WHITE);

    // A second insert of the same ids would throw, so the rerun reaching here is the one org.
    const again = await seed({ fixedId: "rerun" });
    const builds = await fetch(`${serverUrl()}/api/v1/projects/${again.projectId}/builds`, {
      headers: auth(again.token),
    });
    expect(builds.status).toBe(200);
    expect(await builds.json()).toMatchObject({ builds: [] });
  });
});
