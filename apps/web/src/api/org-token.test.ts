import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createOrg, createProject } from "#/db/orgs";
import { builds, projects } from "#/db/schema";
import { orgTokens } from "#/db/schema-org-tokens";
import { issueOrgToken, issueUserToken, revokeOrgToken } from "#/db/tokens";
import { signInGithubUser } from "#/db/users";
import { call, idOf, newBuild, setup, snapshotForm } from "./test-support";

/** Ada belongs to Acme and Other; Acme has an org token, and Eve belongs to neither. */
async function orgs() {
  const base = await setup();
  const acmeOrg = await issueOrgToken(base.db, base.acme.user.id, base.acme.org.id, "monorepo");
  const eve = await signInGithubUser(base.db, {
    githubId: 2,
    login: "eve",
    name: null,
    avatarUrl: null,
  });
  const ada = await issueUserToken(base.db, base.acme.user.id, "laptop", null);
  return { ...base, acmeOrg, ada, eve };
}

const count = async (db: Awaited<ReturnType<typeof orgs>>["db"]) =>
  (await db.select().from(projects)).length;

async function upload(deps: Parameters<typeof call>[0], token: string, projectId: string) {
  const created = await call(deps, "POST /api/v1/builds", token, newBuild({ projectId }));
  if (created.status !== 201) return created;
  const id = await idOf(created);
  expect(
    (await call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, snapshotForm())).status,
  ).toBe(200);
  return call(deps, `POST /api/v1/builds/${id}/finalize`, token, JSON.stringify({ snapshots: 1 }));
}

describe("org CI tokens on the API (ob 1787)", () => {
  test("whoami: an org token is its org", async () => {
    const { deps, acme, acmeOrg } = await orgs();
    const me = await call(deps, "GET /api/v1/me", acmeOrg.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ kind: "org-ci", orgId: acme.org.id });
  });

  test("an org token uploads to two projects of its org, named in the request", async () => {
    const { db, deps, acme, acmeOrg } = await orgs();
    const docs = await createProject(db, acme.user.id, acme.org.id, "docs");
    for (const project of [acme.project, docs]) {
      expect((await upload(deps, acmeOrg.token, project.id)).status).toBe(200);
    }
    const rows = await db.select().from(builds);
    expect(rows.map((b) => b.projectId).toSorted()).toEqual([acme.project.id, docs.id].toSorted());
  });

  test("an org token must name the project", async () => {
    const { deps, acmeOrg } = await orgs();
    const res = await call(deps, "POST /api/v1/builds", acmeOrg.token, newBuild());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "projectId is required with an org token" });
  });

  test("an org token cannot reach another org's project, build or list", async () => {
    const { db, deps, acme, other, acmeOrg } = await orgs();
    const before = await db.select().from(builds);
    const create = await call(
      deps,
      "POST /api/v1/builds",
      acmeOrg.token,
      newBuild({ projectId: other.project.id }),
    );
    expect(create.status).toBe(404);
    const theirs = await idOf(await call(deps, "POST /api/v1/builds", other.token, newBuild()));
    const put = await call(
      deps,
      `PUT /api/v1/builds/${theirs}/snapshots`,
      acmeOrg.token,
      snapshotForm(),
    );
    expect(put.status).toBe(404);
    const preview = await call(
      deps,
      "POST /api/v1/baselines",
      acmeOrg.token,
      JSON.stringify({
        projectId: other.project.id,
        commitSha: "a".repeat(40),
        branch: "x",
        keys: [],
      }),
    );
    expect(preview.status).toBe(404);
    expect((await db.select().from(builds)).length).toBe(before.length + 1);
    const list = await call(deps, "GET /api/v1/projects", acmeOrg.token);
    const body: { projects: { id: string }[] } = await list.json();
    expect(body.projects.map((p) => p.id)).toEqual([acme.project.id]);
  });

  test("a revoked org token is refused, and the project's own CI token still works", async () => {
    const { db, deps, acme, acmeOrg, eve } = await orgs();
    expect((await call(deps, "GET /api/v1/me", acmeOrg.token)).status).toBe(200);
    // Another org's member cannot revoke it: it is a 404, as for a missing token.
    await expect(revokeOrgToken(db, eve.id, acmeOrg.id)).rejects.toThrow(/not found/i);
    await revokeOrgToken(db, acme.user.id, acmeOrg.id);
    expect((await call(deps, "GET /api/v1/me", acmeOrg.token)).status).toBe(401);
    expect((await upload(deps, acmeOrg.token, acme.project.id)).status).toBe(401);
    expect((await upload(deps, acme.token, acme.project.id)).status).toBe(200);
  });

  test("only the hash is stored, and use is stamped", async () => {
    const { db, deps, acmeOrg } = await orgs();
    expect(acmeOrg.token).toMatch(/^psorg_/);
    await call(deps, "GET /api/v1/me", acmeOrg.token);
    const [row] = await db.select().from(orgTokens).where(eq(orgTokens.id, acmeOrg.id));
    expect(row?.tokenHash).not.toContain(acmeOrg.token);
    expect(row?.prefix).toBe(acmeOrg.token.slice(0, 10));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });
});

const create = (deps: Parameters<typeof call>[0], token: string, body: object) =>
  call(deps, "POST /api/v1/projects", token, JSON.stringify(body));

describe("POST /api/v1/projects (ob 1787)", () => {
  test("an org token creates a project by name once, then finds it", async () => {
    const { db, deps, acme, acmeOrg } = await orgs();
    const first = await create(deps, acmeOrg.token, { name: "storefront" });
    expect(first.status).toBe(201);
    const made: { id: string; name: string; org: { id: string }; created: boolean } =
      await first.json();
    expect(made).toMatchObject({ name: "storefront", org: { id: acme.org.id }, created: true });
    const again = await create(deps, acmeOrg.token, { name: "storefront" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: made.id, created: false });
    expect(await create(deps, acmeOrg.token, { name: "web" })).toHaveProperty("status", 200);
    expect(await count(db)).toBe(3);
  });

  test("a project made by name can be uploaded to at once", async () => {
    const { deps, acmeOrg } = await orgs();
    const made: { id: string } = await (await create(deps, acmeOrg.token, { name: "docs" })).json();
    expect((await upload(deps, acmeOrg.token, made.id)).status).toBe(200);
  });

  test("a personal token with one org creates in it; with several it must name one", async () => {
    const { db, deps, ada, eve, acme } = await orgs();
    const ambiguous = await create(deps, ada.token, { name: "x" });
    expect(ambiguous.status).toBe(400);
    expect(JSON.stringify(await ambiguous.json())).toContain("Acme, Other");
    expect(await count(db)).toBe(2);
    expect((await create(deps, ada.token, { name: "x", org: "Acme" })).status).toBe(201);
    expect((await create(deps, ada.token, { name: "y", org: acme.org.id })).status).toBe(201);
    expect((await create(deps, ada.token, { name: "z", org: "Nope" })).status).toBe(404);
    const loner = await issueUserToken(db, eve.id, "laptop", null);
    const none = await create(deps, loner.token, { name: "x" });
    expect(none.status).toBe(400);
    expect(JSON.stringify(await none.json())).toContain("no org");
  });

  test("an org name two of your orgs share must be given by id", async () => {
    const { db, deps, ada, acme } = await orgs();
    const twin = await createOrg(db, acme.user.id, "Acme");
    const asked = await create(deps, ada.token, { name: "x", org: "Acme" });
    expect(asked.status).toBe(400);
    expect(JSON.stringify(await asked.json())).toContain("pass its id");
    expect((await create(deps, ada.token, { name: "x", org: twin.id })).status).toBe(201);
  });

  test("an org token cannot create in another org", async () => {
    const { db, deps, acmeOrg } = await orgs();
    expect((await create(deps, acmeOrg.token, { name: "x", org: "Other" })).status).toBe(404);
    expect(await count(db)).toBe(2);
  });

  test("a project's own CI token cannot create", async () => {
    const { db, deps, acme } = await orgs();
    expect((await create(deps, acme.token, { name: "x" })).status).toBe(403);
    expect(await count(db)).toBe(2);
  });

  test("a bad name is a 400 and creates nothing", async () => {
    const { db, deps, acmeOrg } = await orgs();
    for (const body of [{}, { name: "" }, { name: "   " }, { name: 3 }, { name: "x".repeat(101) }])
      expect((await create(deps, acmeOrg.token, body)).status).toBe(400);
    expect((await call(deps, "POST /api/v1/projects", acmeOrg.token, "nope")).status).toBe(400);
    expect(await count(db)).toBe(2);
  });

  test("an upload to an unknown project creates nothing", async () => {
    const { db, deps, acmeOrg } = await orgs();
    const res = await call(
      deps,
      "POST /api/v1/builds",
      acmeOrg.token,
      newBuild({ projectId: "typo" }),
    );
    expect(res.status).toBe(404);
    expect(await count(db)).toBe(2);
  });
});
