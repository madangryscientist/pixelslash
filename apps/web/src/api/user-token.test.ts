import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { issueUserToken, revokeUserToken } from "#/db/tokens";
import { signInGithubUser } from "#/db/users";
import { call, idOf, newBuild, setup, snapshotForm } from "./test-support";

/** Ada belongs to Acme and Other; Eve belongs to neither. */
async function people() {
  const base = await setup();
  const ada = await issueUserToken(base.db, base.acme.user.id, "laptop", null);
  const eve = await signInGithubUser(base.db, {
    githubId: 2,
    login: "eve",
    name: "Eve",
    avatarUrl: null,
  });
  const eveToken = await issueUserToken(base.db, eve.id, "laptop", null);
  return { ...base, ada, eve: eveToken };
}

describe("personal tokens on the API (ob 1728)", () => {
  test("whoami: a personal token is its user, a CI token its project", async () => {
    const { deps, acme, ada } = await people();
    const me = await call(deps, "GET /api/v1/me", ada.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      kind: "user",
      user: { id: acme.user.id, login: "ada", name: null },
    });
    const ci = await call(deps, "GET /api/v1/me", acme.token);
    expect(await ci.json()).toEqual({ kind: "ci", projectId: acme.project.id });
    expect((await call(deps, "POST /api/v1/me", ada.token)).status).toBe(405);
  });

  test("a personal token uploads to a project its user can see", async () => {
    const { db, deps, blobs, acme, ada } = await people();
    const created = await call(
      deps,
      "POST /api/v1/builds",
      ada.token,
      newBuild({ projectId: acme.project.id }),
    );
    expect(created.status).toBe(201);
    const id = await idOf(created);
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, ada.token, snapshotForm());
    expect(put.status).toBe(200);
    const done = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      ada.token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(done.status).toBe(200);
    const [build] = await db.select().from(builds).where(eq(builds.id, id));
    expect(build?.projectId).toBe(acme.project.id);
    expect([...blobs.data.keys()][0]).toMatch(new RegExp(`^orgs/${acme.org.id}/`));
  });

  test("a personal token must name the project", async () => {
    const { deps, ada } = await people();
    const res = await call(deps, "POST /api/v1/builds", ada.token, newBuild());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required with a personal token" });
  });

  test("a personal token cannot reach another org's project or build", async () => {
    const { db, deps, acme, eve } = await people();
    const create = await call(
      deps,
      "POST /api/v1/builds",
      eve.token,
      newBuild({ projectId: acme.project.id }),
    );
    expect(create.status).toBe(404);
    const id = await idOf(await call(deps, "POST /api/v1/builds", acme.token, newBuild()));
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, eve.token, snapshotForm());
    const fin = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      eve.token,
      JSON.stringify({ snapshots: 0 }),
    );
    expect([put.status, fin.status]).toEqual([404, 404]);
    expect(await db.select().from(snapshots)).toHaveLength(0);
    expect(await db.select().from(builds)).toHaveLength(1);
  });

  test("a CI token cannot name another project, even one of its own user's orgs", async () => {
    const { db, deps, acme, other } = await people();
    const res = await call(
      deps,
      "POST /api/v1/builds",
      acme.token,
      newBuild({ projectId: other.project.id }),
    );
    expect(res.status).toBe(404);
    const own = await call(
      deps,
      "POST /api/v1/builds",
      acme.token,
      newBuild({ projectId: acme.project.id }),
    );
    expect(own.status).toBe(201);
    expect(await db.select().from(builds)).toHaveLength(1);
  });

  test("a revoked or expired personal token is a 401", async () => {
    const { db, deps, acme, ada } = await people();
    expect((await call(deps, "GET /api/v1/me", ada.token)).status).toBe(200);
    await revokeUserToken(db, acme.user.id, ada.id);
    expect((await call(deps, "GET /api/v1/me", ada.token)).status).toBe(401);

    const old = await issueUserToken(db, acme.user.id, "old", new Date(Date.now() - 1000));
    expect((await call(deps, "GET /api/v1/me", old.token)).status).toBe(401);
    expect((await call(deps, "GET /api/v1/me", "psu_nope")).status).toBe(401);
  });
});
