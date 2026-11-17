import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createProject } from "#/db/orgs";
import { snapshots } from "#/db/schema";
import { issueCiToken } from "#/db/tokens";
import { sha256Bytes } from "#/lib/crypto";
import { MAX_KNOWN } from "./validate-known";
import { META, PNG, call, openBuild, setup, snapshotForm } from "./test-support";

/**
 * `POST /api/v1/builds/:id/known` and the PUT that names an image by hash (PS-424): an unchanged
 * shot costs a hash, not a PNG; the project's finished builds are all that is ever matched.
 */

const HASH = async (bytes: Uint8Array<ArrayBuffer> = PNG) => sha256Bytes(bytes.buffer);
const known = (deps: Parameters<typeof call>[0], build: string, token: string, hashes: unknown) =>
  call(deps, `POST /api/v1/builds/${build}/known`, token, JSON.stringify({ sha256: hashes }));

/** A form for a shot sent by hash: the same parts as `snapshotForm`, without `file`. */
function byHashForm(sha256: string, meta: object = META) {
  const form = new FormData();
  form.set("meta", JSON.stringify({ ...meta, sha256 }));
  return form;
}

/** A finished build holding `META` shot with PNG. */
async function finished(deps: Parameters<typeof call>[0], token: string) {
  const id = await openBuild(deps, token);
  await call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, snapshotForm());
  const done = await call(deps, `POST /api/v1/builds/${id}/finalize`, token, '{"snapshots":1}');
  expect(done.status).toBe(200);
  return id;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, "0"));

describe("/known", () => {
  test("names the hashes a finished build of the project holds, in the order asked", async () => {
    const { deps, acme } = await setup();
    await finished(deps, acme.token);
    const held = await HASH();
    const absent = "0".repeat(64);
    const next = await openBuild(deps, acme.token);
    const res = await known(deps, next, acme.token, [absent, held, held]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known: [held] });
  });

  test("a build still uploading holds nothing yet", async () => {
    const { deps, acme } = await setup();
    const open = await openBuild(deps, acme.token);
    await call(deps, `PUT /api/v1/builds/${open}/snapshots`, acme.token, snapshotForm());
    const res = await known(deps, open, acme.token, [await HASH()]);
    expect(await res.json()).toEqual({ known: [] });
  });

  test("another org's hash is never known, and a by-hash PUT naming it is a 409 image_unknown", async () => {
    const { db, deps, acme, other } = await setup();
    await finished(deps, other.token);
    const held = await HASH();
    const mine = await openBuild(deps, acme.token);
    expect(await (await known(deps, mine, acme.token, [held])).json()).toEqual({ known: [] });

    const put = await call(
      deps,
      `PUT /api/v1/builds/${mine}/snapshots`,
      acme.token,
      byHashForm(held),
    );
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({
      error: "no image with that sha256 is held by this project: send the PNG",
      code: "image_unknown",
    });
    expect(await db.select().from(snapshots).where(eq(snapshots.buildId, mine))).toEqual([]);
  });

  test("a sibling project of the same org is not matched either", async () => {
    const { db, deps, acme } = await setup();
    await finished(deps, acme.token);
    const sibling = await createProject(db, acme.user.id, acme.org.id, "docs");
    const { token } = await issueCiToken(db, acme.user.id, sibling.id, "ci");
    const open = await openBuild(deps, token);
    expect(await (await known(deps, open, token, [await HASH()])).json()).toEqual({ known: [] });
    const put = await call(
      deps,
      `PUT /api/v1/builds/${open}/snapshots`,
      token,
      byHashForm(await HASH()),
    );
    expect(put.status).toBe(409);
  });

  test("it is an upload endpoint: a token is needed, another org's build is a 404, errors are strings", async () => {
    const { deps, acme, other } = await setup();
    const open = await openBuild(deps, acme.token);
    expect((await known(deps, open, "psci_wrong", [])).status).toBe(401);
    const stranger = await known(deps, open, other.token, []);
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "build not found" });
    const bad = await known(deps, open, acme.token, ["not-a-hash"]);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.any(String) });
    expect((await call(deps, `POST /api/v1/builds/${open}/known`, acme.token, "{}")).status).toBe(
      400,
    );
  });

  test("takes at most MAX_KNOWN hashes a call", async () => {
    const { deps, acme } = await setup();
    const open = await openBuild(deps, acme.token);
    expect((await known(deps, open, acme.token, many(MAX_KNOWN))).status).toBe(200);
    expect((await known(deps, open, acme.token, many(MAX_KNOWN + 1))).status).toBe(400);
  });
});

describe("a by-hash PUT", () => {
  test("stores the same row as one sent with its file, with the held image's key, hash and size", async () => {
    const { db, deps, blobs, acme } = await setup();
    const first = await finished(deps, acme.token);
    const second = await openBuild(deps, acme.token);
    const metrics = new File(
      [
        JSON.stringify({
          version: "1.0",
          root: "button",
          parts: { button: { box: { x: 0, y: 0, w: 96, h: 40 } } },
        }),
      ],
      "m.json",
    );
    const form = byHashForm(await HASH(), { ...META, tags: ["web", "again"] });
    form.set("metrics", metrics);
    const put = await call(deps, `PUT /api/v1/builds/${second}/snapshots`, acme.token, form);
    expect(put.status).toBe(200);
    const done = await call(
      deps,
      `POST /api/v1/builds/${second}/finalize`,
      acme.token,
      '{"snapshots":1}',
    );
    expect(done.status).toBe(200);

    const [a] = await db.select().from(snapshots).where(eq(snapshots.buildId, first));
    const [b] = await db.select().from(snapshots).where(eq(snapshots.buildId, second));
    expect(b).toMatchObject({
      name: a?.name,
      imageKey: a?.imageKey,
      imageSha256: a?.imageSha256,
      imageSize: a?.imageSize,
      tags: ["web", "again"],
    });
    // The other parts are stored under the shot's own build, as for any shot.
    expect(b?.metricsKey).toMatch(new RegExp(`^builds/${second}/[0-9a-f]{32}\\.metrics\\.json$`));
    // No second copy of the PNG was stored.
    expect([...blobs.data.keys()].filter((k) => k.endsWith(".png"))).toEqual([
      `orgs/${acme.org.id}/${a?.imageKey}`,
    ]);
  });

  test("a PNG sent with its file is stored from those bytes, whatever meta.sha256 says", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const form = snapshotForm({ ...META, sha256: "0".repeat(64) });
    expect((await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, form)).status).toBe(
      200,
    );
    const [row] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(row?.imageSha256).toBe(await HASH());
  });

  test("no file and no sha256 is the 400 it always was; a malformed sha256 is a 400", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const none = new FormData();
    none.set("meta", JSON.stringify(META));
    const missing = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, none);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "file must be a PNG upload" });
    const bad = await call(
      deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      acme.token,
      byHashForm("XYZ"),
    );
    expect(bad.status).toBe(400);
  });

  test("a finalised build still refuses a by-hash PUT with the plain 409", async () => {
    const { deps, acme } = await setup();
    const id = await finished(deps, acme.token);
    const put = await call(
      deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      acme.token,
      byHashForm(await HASH()),
    );
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({ error: "build is finalised" });
  });
});
