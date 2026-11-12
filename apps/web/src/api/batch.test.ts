import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { MAX_PARAMS } from "#/db/chunks";
import { markFlaky } from "#/db/flakes";
import { snapshots } from "#/db/schema";
import { sha256Bytes } from "#/lib/crypto";
import { META, PNG, call, openBuild, setup, snapshotForm } from "./test-support";
import { MAX_BATCH } from "./validate-batch";

/**
 * `POST /api/v1/builds/:id/snapshots/batch`: shots whose PNGs the project holds, registered by
 * hash many to a request. What it stores is what a by-hash PUT of the same shots stores.
 */

type Setup = Awaited<ReturnType<typeof setup>>;
type Deps = Setup["deps"];

const bytesOf = (i: number): Uint8Array<ArrayBuffer> => new Uint8Array([...PNG, i]);
const hashOf = (i: number) => sha256Bytes(bytesOf(i).buffer);
const metaOf = (i: number, extra: object = {}) => ({ ...META, name: `shot-${i}`, ...extra });
const batch = (deps: Deps, build: string, token: string, body: unknown) =>
  call(deps, `POST /api/v1/builds/${build}/snapshots/batch`, token, JSON.stringify(body));
const finalize = (deps: Deps, build: string, token: string, n: number) =>
  call(deps, `POST /api/v1/builds/${build}/finalize`, token, JSON.stringify({ snapshots: n }));

/** A finished build holding shots `0..n-1`, each with its own PNG, so the project holds those images. */
async function finishedWith(s: Setup, n: number) {
  const id = await openBuild(s.deps, s.acme.token);
  for (let i = 0; i < n; i++)
    await call(
      s.deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      s.acme.token,
      snapshotForm(metaOf(i), bytesOf(i)),
    );
  expect((await finalize(s.deps, id, s.acme.token, n)).status).toBe(200);
  return id;
}

/** The rows of a build as the review reads them: everything but the ids and the blob keys of its own. */
async function rowsOf(s: Setup, build: string) {
  const rows = await s.db.select().from(snapshots).where(eq(snapshots.buildId, build));
  return rows
    .map(({ id: _id, buildId: _b, createdAt: _c, ...row }) => row)
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A by-hash PUT's form: the shot's meta with its hash, and no file. */
function byHashForm(sha256: string, meta: object) {
  const form = new FormData();
  form.set("meta", JSON.stringify({ ...meta, sha256 }));
  return form;
}

/** A finalize reply without what differs between two builds: their id and page. */
async function strip(res: Response) {
  const body: Record<string, unknown> = await res.json();
  const { id: _id, web_url: _url, ...rest } = body;
  return rest;
}

describe("the batch endpoint", () => {
  test("stores the same rows and finalises to the same result as per-shot PUTs, changed shots included", async () => {
    const s = await setup();
    await finishedWith(s, 6);
    // A reviewer has marked shot-2 flaky, so a shot of that key takes the label either way.
    const [held] = await s.db.select().from(snapshots).where(eq(snapshots.name, "shot-2"));
    await markFlaky(s.db, {
      userId: s.acme.user.id,
      projectId: s.acme.project.id,
      snapshotId: held?.id ?? "",
      note: null,
    });

    const unchanged = [0, 1, 2, 3, 4, 5];
    const viaBatch = await openBuild(s.deps, s.acme.token);
    const reply = await batch(s.deps, viaBatch, s.acme.token, {
      snapshots: await Promise.all(
        unchanged.map(async (i) => ({ ...metaOf(i, { flaky: "skip" }), sha256: await hashOf(i) })),
      ),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ stored: 6, missing: [] });
    // A changed shot has a PNG the project does not hold: it goes by PUT.
    const changed = snapshotForm(metaOf(6), bytesOf(99));
    expect(
      (await call(s.deps, `PUT /api/v1/builds/${viaBatch}/snapshots`, s.acme.token, changed))
        .status,
    ).toBe(200);

    const viaPut = await openBuild(s.deps, s.acme.token);
    for (const i of unchanged)
      expect(
        (
          await call(
            s.deps,
            `PUT /api/v1/builds/${viaPut}/snapshots`,
            s.acme.token,
            byHashForm(await hashOf(i), metaOf(i, { flaky: "skip" })),
          )
        ).status,
      ).toBe(200);
    await call(
      s.deps,
      `PUT /api/v1/builds/${viaPut}/snapshots`,
      s.acme.token,
      snapshotForm(metaOf(6), bytesOf(99)),
    );

    const a = await rowsOf(s, viaBatch);
    const b = await rowsOf(s, viaPut);
    expect(a).toHaveLength(7);
    // Only shot-2's key has an open flake; the batch labels it as the PUT does.
    expect(a.map((r) => r.flakeId !== null)).toEqual(a.map((r) => r.name === "shot-2"));
    expect(a.map(({ imageKey: _k, metricsKey: _m, ...r }) => r)).toEqual(
      b.map(({ imageKey: _k, metricsKey: _m, ...r }) => r),
    );
    // Held images keep the key of the build they came from; the changed shot's key is its own.
    expect(a.slice(0, 6).map((r) => r.imageKey)).toEqual(b.slice(0, 6).map((r) => r.imageKey));

    const done = await finalize(s.deps, viaBatch, s.acme.token, 7);
    const doneBy = await finalize(s.deps, viaPut, s.acme.token, 7);
    expect(await strip(done)).toEqual(await strip(doneBy));
    const after = await rowsOf(s, viaBatch);
    const afterBy = await rowsOf(s, viaPut);
    expect(after.map(({ imageKey: _k, ...r }) => r)).toEqual(
      afterBy.map(({ imageKey: _k, ...r }) => r),
    );
  });

  test("a hash the project does not hold is named in missing and the rest is stored", async () => {
    const s = await setup();
    await finishedWith(s, 3);
    const build = await openBuild(s.deps, s.acme.token);
    const absent = "0".repeat(64);
    const reply = await batch(s.deps, build, s.acme.token, {
      snapshots: [
        { ...metaOf(0), sha256: await hashOf(0) },
        { ...metaOf(1), sha256: absent },
        { ...metaOf(2), sha256: await hashOf(2) },
        { ...metaOf(7), sha256: absent },
      ],
    });
    expect(await reply.json()).toEqual({ stored: 2, missing: [absent] });
    const rows = await rowsOf(s, build);
    expect(rows.map((r) => r.name)).toEqual(["shot-0", "shot-2"]);
  });

  test("a batch bigger than one statement binds is written in several, each within D1's limit", async () => {
    const inserts: string[] = [];
    const s = await setup((query) => {
      if (query.includes(" union all ")) inserts.push(query);
    });
    await finishedWith(s, 1);
    const build = await openBuild(s.deps, s.acme.token);
    const hash = await hashOf(0);
    const shots = Array.from({ length: 60 }, (_, i) => ({
      ...metaOf(i, { tags: ["web"], flaky: "review" }),
      sha256: hash,
    }));
    const reply = await batch(s.deps, build, s.acme.token, { snapshots: shots });
    expect(await reply.json()).toEqual({ stored: 60, missing: [] });
    expect(inserts.length).toBeGreaterThan(1);
    for (const q of inserts) expect(q.split("?").length - 1).toBeLessThanOrEqual(MAX_PARAMS);
    expect(await rowsOf(s, build)).toHaveLength(60);
    expect((await finalize(s.deps, build, s.acme.token, 60)).status).toBe(200);
  });

  test("a key sent twice keeps one row, and a batch sent twice replaces itself", async () => {
    const s = await setup();
    await finishedWith(s, 2);
    const build = await openBuild(s.deps, s.acme.token);
    const body = {
      snapshots: [
        { ...metaOf(0), sha256: await hashOf(0) },
        { ...metaOf(0, { tags: ["again"] }), sha256: await hashOf(1) },
      ],
    };
    expect(await (await batch(s.deps, build, s.acme.token, body)).json()).toEqual({
      stored: 1,
      missing: [],
    });
    await batch(s.deps, build, s.acme.token, body);
    const rows = await rowsOf(s, build);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tags: ["again"], imageSha256: await hashOf(1) });
  });

  test("one bad item fails the request and writes nothing", async () => {
    const s = await setup();
    await finishedWith(s, 2);
    const build = await openBuild(s.deps, s.acme.token);
    const good = { ...metaOf(0), sha256: await hashOf(0) };
    for (const bad of [
      { ...metaOf(1), sha256: "not-a-hash" },
      { ...metaOf(1) },
      { ...metaOf(1), name: 7, sha256: await hashOf(1) },
      { ...metaOf(1), flake: { runs: 2 }, sha256: await hashOf(1) },
      { ...metaOf(1), ci: { engineVersion: "x", results: [] }, sha256: await hashOf(1) },
    ]) {
      const reply = await batch(s.deps, build, s.acme.token, { snapshots: [good, bad] });
      expect(reply.status).toBe(400);
      // The message names the item, so a client can find the shot in a batch of a thousand.
      expect(await reply.json()).toEqual({ error: expect.stringContaining("snapshots[1]") });
    }
    expect((await batch(s.deps, build, s.acme.token, {})).status).toBe(400);
    expect(await rowsOf(s, build)).toEqual([]);
  });

  test("takes at most MAX_BATCH shots a request", async () => {
    const s = await setup();
    const build = await openBuild(s.deps, s.acme.token);
    const sha256 = "1".repeat(64);
    const some = (n: number) => ({
      snapshots: Array.from({ length: n }, (_, i) => ({ ...metaOf(i), sha256 })),
    });
    expect((await batch(s.deps, build, s.acme.token, some(MAX_BATCH))).status).toBe(200);
    expect((await batch(s.deps, build, s.acme.token, some(MAX_BATCH + 1))).status).toBe(400);
  });

  test("is an upload endpoint: a token is needed, another org's build is a 404, a finalised build a 409", async () => {
    const s = await setup();
    await finishedWith(s, 1);
    const body = { snapshots: [{ ...metaOf(0), sha256: await hashOf(0) }] };
    const open = await openBuild(s.deps, s.acme.token);
    expect((await batch(s.deps, open, "psci_wrong", body)).status).toBe(401);
    const stranger = await batch(s.deps, open, s.other.token, body);
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "build not found" });
    await batch(s.deps, open, s.acme.token, body);
    expect((await finalize(s.deps, open, s.acme.token, 1)).status).toBe(200);
    const late = await batch(s.deps, open, s.acme.token, body);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "build is finalised" });
  });
});
