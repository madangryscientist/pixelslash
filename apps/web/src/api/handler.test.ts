import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { snapshotDiffOptions } from "#/db/builds";
import { builds, snapshots } from "#/db/schema";
import { revokeCiToken } from "#/db/tokens";
import { usageCounts } from "#/db/usage";
import { type ApiDeps, handleApi } from "./handler";
import { MAX_PNG_BYTES } from "./snapshot-form";
import { MAX_FLAKE_RUNS } from "./validate";
import {
  META,
  PNG,
  SHA,
  call,
  idOf,
  memoryStore,
  newBuild,
  openBuild,
  setup,
  snapshotForm,
} from "./test-support";

describe("upload API", () => {
  test("a build takes snapshots and finalises; the PNG lands under the org's prefix", async () => {
    const { db, deps, blobs, acme } = await setup();
    const created = await call(
      deps,
      `POST /api/v1/builds`,
      acme.token,
      newBuild({ ancestorShas: ["c".repeat(40), "d".repeat(40)], prNumber: 7 }),
    );
    expect(created.status).toBe(201);
    const id = await idOf(created);

    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    expect(put.status).toBe(200);
    const done = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(await done.json()).toEqual({
      id,
      // A shot with nothing to compare against waits for a decision on a branch (PS-284).
      status: "changes",
      error: null,
      unmeasured: 0,
      web_url: `http://app.test/projects/${acme.project.id}/builds/${id}`,
    });

    const [build] = await db.select().from(builds).where(eq(builds.id, id));
    expect(build).toMatchObject({
      projectId: acme.project.id,
      commitSha: SHA,
      branch: "feat/x",
      mergeBaseSha: "b".repeat(40),
      ancestorShas: ["c".repeat(40), "d".repeat(40)],
      prNumber: 7,
      status: "changes",
    });
    const [snap] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(snap).toMatchObject({ name: "pricing", viewport: "1280x720", tags: ["web"] });
    expect(snap?.diffOptions).toEqual(META.diff);
    expect(await snapshotDiffOptions(db, snap?.id ?? "")).toEqual(META.diff);
    expect(JSON.parse(snap?.envFingerprint ?? "")).toEqual(META.fingerprint);
    expect([...blobs.data.keys()]).toEqual([`orgs/${acme.org.id}/${snap?.imageKey}`]);
    expect(await usageCounts(db)).toEqual({ builds: 1, snapshots: 1 });
  });

  test("a snapshot sent without diff options stores {}", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const { diff: _diff, ...old } = META;
    const put = await call(
      deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      acme.token,
      snapshotForm(old),
    );
    expect(put.status).toBe(200);
    const [snap] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(snap?.diffOptions).toEqual({});
  });

  test("the judge's sentence is stored as sent; a malformed one is dropped, not refused (ob 1745)", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `PUT /api/v1/builds/${id}/snapshots`;
    const noteOf = async (name: string) => {
      const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
      return rows.find((r) => r.name === name)?.changeNote;
    };
    const sent = snapshotForm({ ...META, changeNote: "  The button\nturned red. " });
    expect((await call(deps, path, acme.token, sent)).status).toBe(200);
    expect(await noteOf("pricing")).toBe("The button turned red");
    const long = snapshotForm({ ...META, name: "long", changeNote: "a".repeat(500) });
    expect((await call(deps, path, acme.token, long)).status).toBe(200);
    expect(await noteOf("long")).toHaveLength(300);
    for (const changeNote of [42, "   ", null]) {
      const form = snapshotForm({ ...META, name: "odd", changeNote });
      expect((await call(deps, path, acme.token, form)).status).toBe(200);
      expect(await noteOf("odd")).toBeNull();
    }
  });

  test("a missing, wrong or revoked token is refused before anything is written", async () => {
    const { db, deps, blobs, acme } = await setup();
    for (const token of [null, "psci_nope", "not-a-token"]) {
      expect((await call(deps, `POST /api/v1/builds`, token, newBuild())).status).toBe(401);
    }
    const id = await openBuild(deps, acme.token);
    await revokeCiToken(db, acme.user.id, acme.tokenId);
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    expect(put.status).toBe(401);
    expect(await db.select().from(snapshots)).toHaveLength(0);
    expect(blobs.data.size).toBe(0);
  });

  test("another org's token cannot see or write this project's build", async () => {
    const { db, deps, blobs, acme, other } = await setup();
    const id = await openBuild(deps, acme.token);
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, other.token, snapshotForm());
    const fin = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      other.token,
      JSON.stringify({ snapshots: 0 }),
    );
    expect([put.status, fin.status]).toEqual([404, 404]);
    expect(await db.select().from(snapshots)).toHaveLength(0);
    expect(blobs.data.size).toBe(0);
    const [build] = await db.select().from(builds).where(eq(builds.id, id));
    expect(build?.status).toBe("uploading");
  });

  test("sending a snapshot again replaces it, in the row and in the blob", async () => {
    const { db, deps, blobs, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `/api/v1/builds/${id}/snapshots`;
    await call(deps, `PUT ${path}`, acme.token, snapshotForm());
    const second = new Uint8Array([...PNG, 9, 9]);
    await call(
      deps,
      `PUT ${path}`,
      acme.token,
      snapshotForm({ ...META, tags: ["billing"] }, second),
    );
    await call(deps, `PUT ${path}`, acme.token, snapshotForm({ ...META, name: "home" }));

    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(rows.map((r) => r.name).toSorted()).toEqual(["home", "pricing"]);
    const pricing = rows.find((r) => r.name === "pricing");
    expect(pricing?.tags).toEqual(["billing"]);
    expect(blobs.data.size).toBe(2);
    const stored = blobs.data.get(`orgs/${acme.org.id}/${pricing?.imageKey}`);
    expect(new Uint8Array(stored ?? new ArrayBuffer(0))).toEqual(second);
  });

  test("the CLI's timings sent at finalize are stored; without them, or malformed, the column stays null", async () => {
    const { db, deps, acme } = await setup();
    const timings = {
      totalMs: 1200,
      captureMs: 800,
      diffMs: 40,
      upload: { totalMs: 300, batches: [{ step: "upload", count: 1, ms: 250 }] },
      shots: [{ name: "pricing", captureMs: 800, diffMs: 40 }],
    };
    const stored = async (body: unknown) => {
      const id = await openBuild(deps, acme.token);
      await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
      const res = await call(
        deps,
        `POST /api/v1/builds/${id}/finalize`,
        acme.token,
        JSON.stringify(body),
      );
      expect(res.status).toBe(200);
      const [row] = await db.select().from(builds).where(eq(builds.id, id));
      return row?.timings;
    };
    expect(await stored({ snapshots: 1, timings })).toEqual(timings);
    expect(await stored({ snapshots: 1 })).toBeNull();
    expect(await stored({ snapshots: 1, timings: { totalMs: -1, shots: [] } })).toBeNull();
    expect(await stored({ snapshots: 1, timings: "slow" })).toBeNull();
    expect(
      await stored({
        snapshots: 1,
        timings: { totalMs: 5, shots: [{ name: "x", captureMs: "1" }] },
      }),
    ).toBeNull();
  });

  test("a finalised build is immutable; finalising again is only a retry", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    const finalize = (n: number) =>
      call(
        deps,
        `POST /api/v1/builds/${id}/finalize`,
        acme.token,
        JSON.stringify({ snapshots: n }),
      );
    expect((await finalize(1)).status).toBe(200);

    const late = await call(
      deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      acme.token,
      snapshotForm({ ...META, name: "late" }),
    );
    expect(late.status).toBe(409);
    expect((await finalize(1)).status).toBe(200);
    expect((await finalize(2)).status).toBe(409);
    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(rows).toHaveLength(1);
  });

  test("finalise with the wrong count leaves the build open and uncounted", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    const res = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ snapshots: 3 }),
    );
    expect(res.status).toBe(409);
    const [build] = await db
      .select()
      .from(builds)
      .where(and(eq(builds.id, id)));
    expect(build?.status).toBe("uploading");
    expect(await usageCounts(db)).toEqual({ builds: 0, snapshots: 0 });
  });

  test("a failed blob write leaves no snapshot row", async () => {
    const { db, acme } = await setup();
    const deps: ApiDeps = {
      db,
      store: memoryStore(true).store,
      imageSecret: () => "s",
      defaultDiffLocation: () => "server",
    };
    const id = await openBuild(deps, acme.token);
    await expect(
      call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm()),
    ).rejects.toThrow(/r2 down/);
    expect(await db.select().from(snapshots)).toHaveLength(0);
  });

  test("bad input is a 400 and writes nothing", async () => {
    const { db, deps, blobs, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `/api/v1/builds/${id}/snapshots`;
    const bad = async (body: BodyInit) =>
      (await call(deps, `PUT ${path}`, acme.token, body)).status;

    expect(await bad(snapshotForm(META, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])))).toBe(400);
    expect(await bad(snapshotForm({ ...META, theme: "sepia" }))).toBe(400);
    expect(await bad(snapshotForm({ ...META, viewport: "wide" }))).toBe(400);
    expect(await bad(snapshotForm({ ...META, name: "" }))).toBe(400);
    const diffs: unknown[] = [{ threshold: 2 }, { mergeDistance: 2.5 }, { noiseAmplitude: 2 }];
    diffs.push({ maxShift: 2 }, 0.2);
    for (const diff of diffs) expect(await bad(snapshotForm({ ...META, diff }))).toBe(400);
    expect(await bad("not multipart")).toBe(400);
    expect(await db.select().from(snapshots)).toHaveLength(0);
    expect(blobs.data.size).toBe(0);

    const make = async (body: object | string) =>
      (
        await call(
          deps,
          `POST /api/v1/builds`,
          acme.token,
          typeof body === "string" ? body : JSON.stringify(body),
        )
      ).status;
    expect(await make("{")).toBe(400);
    expect(await make({ commitSha: "xyz", branch: "main" })).toBe(400);
    expect(await make({ commitSha: SHA, branch: "main", ancestorShas: Array(201).fill(SHA) })).toBe(
      400,
    );
    expect(await make({ commitSha: SHA, branch: "main", prNumber: 0 })).toBe(400);
    expect(await make({ commitSha: SHA, branch: "main", ancestorShas: Array(200).fill(SHA) })).toBe(
      201,
    );
  });

  test("an oversize PNG is refused unread", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const res = await handleApi(
      new Request(`http://app.test/api/v1/builds/${id}/snapshots`, {
        method: "PUT",
        body: "x",
        headers: {
          authorization: `Bearer ${acme.token}`,
          // The cap counts the shot and every flake:<run> re-capture it may carry (ob 1724).
          "content-length": String(MAX_FLAKE_RUNS * MAX_PNG_BYTES + 1_000_000),
        },
      }),
      deps,
    );
    expect(res.status).toBe(413);
  });

  test("unknown paths and methods are refused", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    expect((await call(deps, `GET /api/v1/builds`, acme.token)).status).toBe(405);
    expect((await call(deps, `GET /api/v1/builds/${id}/snapshots`, acme.token)).status).toBe(405);
    expect((await call(deps, `GET /api/v1/nope`, acme.token)).status).toBe(404);
    expect((await call(deps, `GET /api/v1/builds/${id}/other`, acme.token)).status).toBe(404);
    // The method is checked by path alone (ob 1729), so a wrong one is a 405 for any build id.
    expect((await call(deps, `GET /api/v1/builds/missing/snapshots`, acme.token)).status).toBe(405);
    expect((await call(deps, `PUT /api/v1/builds/missing/snapshots`, acme.token)).status).toBe(404);
  });
});
