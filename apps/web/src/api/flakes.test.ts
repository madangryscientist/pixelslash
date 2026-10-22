import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { flakes, snapshots } from "#/db/schema";
import { issueUserToken } from "#/db/tokens";
import { signInGithubUser } from "#/db/users";
import type { ApiFlake } from "./flakes";
import { META, PNG, call, openBuild, setup, snapshotForm } from "./test-support";
import { parseFlake, parseFlaky } from "./validate";

/** Flakes over API v1 (ob 1724): uploaded with a shot, listed, resolved by a person only. */

const FLAKE = { runs: 3, differed: [2], regions: [], engineVersion: "0.1.0", policy: "skip" };

function flakyForm(meta: object) {
  const form = snapshotForm(meta);
  form.set("flake:2", new File([PNG.slice()], "run2.png", { type: "image/png" }));
  form.set("flake:3", new File([PNG.slice()], "run3.png", { type: "image/png" }));
  return form;
}

async function flakyUpload() {
  const held = await setup();
  const id = await openBuild(held.deps, held.acme.token);
  const put = await call(
    held.deps,
    `PUT /api/v1/builds/${id}/snapshots`,
    held.acme.token,
    flakyForm({ ...META, flaky: "skip", flake: FLAKE }),
  );
  expect(put.status).toBe(200);
  const ada = await issueUserToken(held.db, held.acme.user.id, "laptop", null);
  return { ...held, buildId: id, ada: ada.token };
}

type Body = {
  flakes: ApiFlake[];
  flake: ApiFlake;
  next_cursor: null;
  error: { code: string; message: string };
};
async function json(res: Response) {
  const body: Body = await res.json();
  return { status: res.status, body };
}

describe("flakes over the API (ob 1724)", () => {
  test("an upload stores the record, the policy and the re-captures", async () => {
    const { db, blobs, acme, buildId } = await flakyUpload();
    const [shot] = await db.select().from(snapshots).where(eq(snapshots.buildId, buildId));
    expect(shot?.flakyPolicy).toBe("skip");
    const [flake] = await db.select().from(flakes);
    expect(shot?.flakeId).toBe(flake?.id);
    expect(flake?.evidence).toHaveLength(1);
    expect(flake?.evidence[0]).toMatchObject({ runs: 3, differed: [2], policy: "skip" });
    expect([...blobs.data.keys()].toSorted()).toEqual(
      [shot?.imageKey, ...(flake?.evidence[0]?.captures.map((c) => c.key) ?? [])]
        .map((k) => `orgs/${acme.org.id}/${k}`)
        .toSorted(),
    );
  });

  test("a garbage flake record or policy is dropped, not refused", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const put = await call(
      deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      acme.token,
      flakyForm({ ...META, flaky: "sometimes", flake: { ...FLAKE, runs: 1 } }),
    );
    expect(put.status).toBe(200);
    const [shot] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(shot).toMatchObject({ flakeId: null, flakyPolicy: null });
    expect(await db.select().from(flakes)).toHaveLength(0);
  });

  test("list with evidence and signed images; resolve with a note names the person", async () => {
    const { deps, acme, ada } = await flakyUpload();
    for (const token of [acme.token, ada]) {
      const list = await json(
        await call(deps, `GET /api/v1/projects/${acme.project.id}/flakes`, token),
      );
      expect(list.status).toBe(200);
      expect(list.body.next_cursor).toBeNull();
      expect(list.body.flakes).toHaveLength(1);
      const [flake] = list.body.flakes;
      expect(flake).toMatchObject({ status: "open", name: "pricing", created_by: null });
      expect(flake?.evidence[0]?.images.runs.map((r) => r.run)).toEqual([2, 3]);
      expect(flake?.evidence[0]?.images.head).toMatch(/^http:\/\/app\.test\/images\//);
    }
    const [flake] = (
      await json(await call(deps, `GET /api/v1/projects/${acme.project.id}/flakes`, ada))
    ).body.flakes;
    const done = await json(
      await call(
        deps,
        `POST /api/v1/flakes/${flake?.id}/resolve`,
        ada,
        JSON.stringify({ note: "  pinned the clock  " }),
      ),
    );
    expect(done.status).toBe(200);
    expect(done.body.flake).toMatchObject({
      id: flake?.id,
      status: "resolved",
      resolved_by: "ada",
      resolution_note: "pinned the clock",
    });
  });

  test("a CI token may list but gets 403 on resolve", async () => {
    const { db, deps, acme } = await flakyUpload();
    const [flake] = await db.select().from(flakes);
    const res = await json(
      await call(deps, `POST /api/v1/flakes/${flake?.id}/resolve`, acme.token, "{}"),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    const [after] = await db.select().from(flakes);
    expect(after?.status).toBe("open");
  });

  test("another project's token and an outsider reach nothing", async () => {
    const { db, deps, acme, other } = await flakyUpload();
    const [flake] = await db.select().from(flakes);
    const list = await call(deps, `GET /api/v1/projects/${acme.project.id}/flakes`, other.token);
    expect(list.status).toBe(404);
    const eve = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    const eveToken = (await issueUserToken(db, eve.id, "laptop", null)).token;
    const eveList = await call(deps, `GET /api/v1/projects/${acme.project.id}/flakes`, eveToken);
    expect(eveList.status).toBe(404);
    const resolve = await json(
      await call(deps, `POST /api/v1/flakes/${flake?.id}/resolve`, eveToken, "{}"),
    );
    expect(resolve.status).toBe(404);
    expect(resolve.body.error.message).toBe("flake not found");
    const missing = await call(deps, `POST /api/v1/flakes/nope/resolve`, eveToken, "{}");
    expect(missing.status).toBe(404);
    const [after] = await db.select().from(flakes);
    expect(after?.status).toBe("open");
  });

  test("a note over 200 characters is a 400", async () => {
    const { db, deps, ada } = await flakyUpload();
    const [flake] = await db.select().from(flakes);
    const res = await call(
      deps,
      `POST /api/v1/flakes/${flake?.id}/resolve`,
      ada,
      JSON.stringify({ note: "x".repeat(201) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("parseFlake and parseFlaky drop what is not a flake (ob 1724)", () => {
  const region = { x: 1, y: 2, w: 3, h: 4, changedPixels: 5, antialiasedPixels: 0, kind: "change" };

  test("a well-formed record is kept, its differing runs sorted", () => {
    const regions = [{ run: 3, regions: [region] }];
    expect(parseFlake({ ...FLAKE, differed: [3, 2], regions })).toEqual({
      runs: 3,
      differed: [2, 3],
      regions,
      engineVersion: "0.1.0",
      policy: "skip",
    });
  });

  test.each([
    ["no runs differed", { ...FLAKE, differed: [] }],
    ["a run out of range", { ...FLAKE, differed: [4] }],
    ["run 1 differing from itself", { ...FLAKE, differed: [1] }],
    ["a repeated run", { ...FLAKE, differed: [2, 2] }],
    ["one run", { ...FLAKE, runs: 1 }],
    ["too many runs", { ...FLAKE, runs: 11 }],
    ["an unknown policy", { ...FLAKE, policy: "maybe" }],
    ["a bad region", { ...FLAKE, regions: [{ run: 2, regions: [{ ...region, kind: "x" }] }] }],
    ["not an object", "flaky"],
  ])("%s is dropped", (_, raw) => {
    expect(parseFlake(raw)).toBeNull();
  });

  test("only review and skip are policies", () => {
    expect([parseFlaky("review"), parseFlaky("skip"), parseFlaky("Skip"), parseFlaky(1)]).toEqual([
      "review",
      "skip",
      null,
      null,
    ]);
  });
});
