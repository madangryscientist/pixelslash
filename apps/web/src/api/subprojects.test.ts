import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { InheritedFromParentError } from "#/db/effective";
import { projectModelFor, setOrgModel, setProjectModel } from "#/db/models";
import {
  SubprojectDepthError,
  ensureProject,
  getProject,
  setDefaultBranch,
  setGithubRepo,
} from "#/db/orgs";
import { setGithubComment } from "#/db/github-comment";
import { builds, snapshots } from "#/db/schema";
import { TEST_MODEL_KEY_SECRET } from "#/db/test-db";
import { issueCiToken, issueUserToken } from "#/db/tokens";
import { sha } from "#/diff/test-builds";
import { CHANGED, PLAIN, world } from "#/github/test-world";
import { call, newBuild } from "./test-support";

/** Subprojects: org > project > optional subproject, with builds and review per subproject. */

const MODEL = {
  baseUrl: "https://models.test/v1",
  model: "m",
  apiKey: "k",
  autoPassNoise: false,
  modelKeySecret: TEST_MODEL_KEY_SECRET,
  modelHosts: { allowPrivate: false, resolve: async () => ["203.0.113.10"] },
};

async function withE2e() {
  const w = await world({ repo: null });
  const e2e = await w.addSubproject("e2e");
  const shotsOf = async (buildId: string) =>
    w.db.select().from(snapshots).where(eq(snapshots.buildId, buildId));
  return { ...w, e2e, shotsOf };
}

describe("a subproject's builds", () => {
  test("a CI token with subproject lands on it, and baselines come only from its own builds", async () => {
    const w = await withE2e();
    // The parent has a main build; the subproject has none yet.
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const first = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
      subproject: "e2e",
    });
    expect((await w.buildRow(first.id))?.projectId).toBe(w.e2e.id);
    // Nothing of the parent's was its baseline: the shot is new, not a change against the parent's.
    expect((await w.shotsOf(first.id)).map((s) => s.diffStatus)).toEqual(["new"]);

    await w.finalise({ commit: sha(3), branch: "main", png: PLAIN, subproject: "e2e" });
    const second = await w.finalise({
      commit: sha(4),
      branch: "feat/y",
      mergeBase: sha(3),
      png: CHANGED,
      subproject: "e2e",
    });
    expect(second.body.status).toBe("changes");
    expect((await w.shotsOf(second.id)).map((s) => s.diffStatus)).toEqual(["changed"]);
  });

  test("the same token with no subproject lands on the project itself, with its own baselines", async () => {
    const w = await withE2e();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN, subproject: "e2e" });
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const own = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });
    expect((await w.buildRow(own.id))?.projectId).toBe(w.acme.project.id);
    expect(own.body.status).toBe("changes");
  });

  test("an unknown subproject is a 404 unknown_subproject, and no build is made", async () => {
    const w = await withE2e();
    const res = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ subproject: "nope" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "unknown_subproject" });
    expect(await w.db.select().from(builds)).toEqual([]);
  });

  test("another project's subproject is out of a CI token's reach", async () => {
    const w = await withE2e();
    const theirs = await ensureProject(w.db, w.other.org.id, {
      name: "e2e",
      parentId: w.other.project.id,
    });
    const res = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ projectId: theirs.project.id }),
    );
    expect(res.status).toBe(404);
    const direct = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ projectId: w.e2e.id }),
    );
    expect(direct.status).toBe(201);
  });

  test("a subproject auto-accepts a build on its parent's default branch", async () => {
    const w = await withE2e();
    await setDefaultBranch(w.db, w.acme.user.id, w.acme.project.id, "trunk");
    await w.finalise({ commit: sha(1), branch: "trunk", png: PLAIN, subproject: "e2e" });
    const moved = await w.finalise({
      commit: sha(2),
      branch: "trunk",
      mergeBase: sha(1),
      png: CHANGED,
      subproject: "e2e",
    });
    expect(moved.body.status).toBe("passed");
    expect((await w.shotsOf(moved.id)).map((s) => s.reviewState)).toEqual(["accepted"]);
    // Its own column was never the one read: "main" there is not its default branch.
    const onMain = await w.finalise({
      commit: sha(3),
      branch: "main",
      mergeBase: sha(2),
      png: PLAIN,
      subproject: "e2e",
    });
    expect(onMain.body.status).toBe("changes");
  });

  test("a skipped run is a passed build with no shots, and leaves the baselines as they were", async () => {
    const w = await withE2e();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN, subproject: "e2e" });
    const skipped = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ commitSha: sha(2), branch: "main", subproject: "e2e", skipped: true }),
    );
    expect(skipped.status).toBe(201);
    const { id }: { id: string } = await skipped.json();
    expect(await w.buildRow(id)).toMatchObject({ status: "passed", projectId: w.e2e.id });
    expect(await w.shotsOf(id)).toEqual([]);
    const next = await w.finalise({
      commit: sha(3),
      branch: "feat/x",
      mergeBase: sha(2),
      ancestors: [sha(1)],
      png: CHANGED,
      subproject: "e2e",
    });
    expect((await w.shotsOf(next.id)).map((s) => s.diffStatus)).toEqual(["changed"]);
  });
});

describe("making a subproject", () => {
  test("is idempotent, its name is its parent's to keep unique, and depth is two", async () => {
    const w = await withE2e();
    const again = await ensureProject(w.db, w.acme.org.id, {
      name: "e2e",
      parentId: w.acme.project.id,
    });
    expect(again).toEqual({ project: w.e2e, created: false });
    // The same name at the top level is another project.
    const top = await ensureProject(w.db, w.acme.org.id, { name: "e2e" });
    expect(top.created).toBe(true);
    await expect(
      ensureProject(w.db, w.acme.org.id, { name: "deep", parentId: w.e2e.id }),
    ).rejects.toThrow(SubprojectDepthError);
    await expect(
      ensureProject(w.db, w.other.org.id, { name: "x", parentId: w.acme.project.id }),
    ).rejects.toThrow("parent project not found");
  });

  test("POST /api/v1/projects with parent, and GET lists parent_project_id", async () => {
    const w = await world({ repo: null });
    const user = await issueUserToken(w.db, w.acme.user.id, "cli", null);
    const post = (body: object) =>
      call(w.deps, "POST /api/v1/projects", user.token, JSON.stringify({ org: "Acme", ...body }));
    const made = await post({ name: "e2e", parent: "web" });
    expect(made.status).toBe(201);
    const body: { id: string; parent_project_id: string | null } = await made.json();
    expect(body.parent_project_id).toBe(w.acme.project.id);
    const again = await post({ name: "e2e", parent: w.acme.project.id });
    expect(again.status).toBe(200);
    const same: { id: string } = await again.json();
    expect(same.id).toBe(body.id);

    const deep = await post({ name: "deep", parent: body.id });
    expect(deep.status).toBe(400);
    expect((await post({ name: "x", parent: "missing" })).status).toBe(404);

    const list = await call(w.deps, "GET /api/v1/projects", user.token);
    const { projects: rows }: { projects: { name: string; parent_project_id: string | null }[] } =
      await list.json();
    expect(rows.map((p) => [p.name, p.parent_project_id])).toEqual([
      ["e2e", w.acme.project.id],
      ["web", null],
      ["web", null],
    ]);
  });
});

describe("what a subproject reads from its parent", () => {
  test("repo, comment switch, default branch and model are its parent's, and writing them is refused", async () => {
    const w = await withE2e();
    const { db } = w;
    const userId = w.acme.user.id;
    await setGithubRepo(db, userId, w.acme.project.id, "acme/web");
    await setDefaultBranch(db, userId, w.acme.project.id, "trunk");
    const seen = await getProject(db, userId, w.e2e.id);
    expect(seen).toMatchObject({
      githubRepo: "acme/web",
      defaultBranch: "trunk",
      githubComment: true,
    });

    for (const write of [
      () => setGithubRepo(db, userId, w.e2e.id, "acme/e2e"),
      () => setDefaultBranch(db, userId, w.e2e.id, "dev"),
      () => setGithubComment(db, userId, w.e2e.id, false),
      () => setProjectModel(db, userId, w.e2e.id, MODEL),
      () => issueCiToken(db, userId, w.e2e.id, "ci"),
    ])
      await expect(write()).rejects.toThrow(InheritedFromParentError);

    await setOrgModel(db, userId, w.acme.org.id, { ...MODEL, model: "org" });
    expect((await projectModelFor(db, w.e2e.id, TEST_MODEL_KEY_SECRET))?.model).toBe("org");
    await setProjectModel(db, userId, w.acme.project.id, { ...MODEL, model: "parent" });
    expect((await projectModelFor(db, w.e2e.id, TEST_MODEL_KEY_SECRET))?.model).toBe("parent");
  });
});
